import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { Store } from "../src/server/store.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { HISTORY_PROJECTION_SCHEMA_SQL, prepareHistoryProjectionBatch, type HistoryProjectionBatch } from "../src/server/history-projection.ts";
import { STORE_OPPORTUNITY_INDEXES } from "../src/server/store-database.ts";
import type { ImprovementOpportunity } from "../src/shared/execution-evidence.ts";
import { finishHistoryExecution, historyExecution, historyFixture, historySpec, type HistoryFixture } from "./helpers/history-fixture.ts";

const fixtures: HistoryFixture[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() { const value = historyFixture(); fixtures.push(value); return value; }
function database<T>(filename: string, operation: (db: Database) => T): T {
  const db = new Database(filename, { create: false, strict: true });
  try { return operation(db); } finally { db.close(true); }
}
function opportunity(runId: string): ImprovementOpportunity {
  // Storage metadata only: no source policy, execution, or physical effect is authored.
  return { opportunity_id: "storage-review", run_id: runId, kind: "outcome",
    version: { run_id: runId, skill_id: "historical-storage-reference", version: 1, hash: "a".repeat(64) },
    execution_id: "historical-storage-execution", event_seqs: [], created_at: "2020-01-01T00:00:00.000Z", resolution: null };
}
const resolution: NonNullable<ImprovementOpportunity["resolution"]> = {
  decision: "keep", reason: "Storage-only immutable decision", revision: null, event_seqs: [], measured: false, at: "2020-01-02T00:00:00.000Z",
};
function legacyCombined(f: HistoryFixture): void {
  const location = f.store.readLocation();
  f.store.close();
  database(location.database, db => {
    db.query("ATTACH DATABASE ? AS derived").run(location.projection!);
    db.transaction(() => {
      db.exec(HISTORY_PROJECTION_SCHEMA_SQL.replace(/CREATE TRIGGER[\s\S]*$/, ""));
      db.exec("INSERT INTO evidence_objects(rowid,run_id,kind,object_key,payload) SELECT rowid,run_id,kind,object_key,payload FROM derived.evidence_objects");
      for (const table of ["history_projection_rows", "history_projection_checkpoints", "history_projection_generations", "history_opportunity_visibility", "history_opportunity_updates"])
        db.exec(`INSERT INTO ${table} SELECT * FROM derived.${table}`);
      db.exec(HISTORY_PROJECTION_SCHEMA_SQL);
      for (const index of STORE_OPPORTUNITY_INDEXES) db.exec(index.sql);
      db.exec("DROP TABLE projection_storage_binding; DROP TABLE projection_publications; DROP TABLE projection_audit_receipts; PRAGMA user_version=7");
    })();
    db.exec("DETACH DATABASE derived");
  });
  rmSync(location.projection!);
  for (const suffix of ["-wal", "-shm"]) rmSync(location.projection! + suffix, { force: true });
}

test("derived rows use the explicit location while a derived write lock does not block canonical events", () => {
  const f = fixture(), location = f.store.readLocation();
  expect(location.projection).toBeDefined();
  expect(location.projection).not.toBe(location.database);
  f.store.saveOpportunity(opportunity(f.run.run_id));
  database(location.database, db => {
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM evidence_objects WHERE kind='opportunity'").get()!.n).toBe(0);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='history_projection_rows'").get()).toBeNull();
  });
  database(location.projection!, db => {
    db.exec("BEGIN IMMEDIATE");
    try { expect(f.store.event(f.run.run_id, "storage.probe", "Canonical ledger stays independently writable").event_seq).toBeGreaterThan(0); }
    finally { db.exec("ROLLBACK"); }
  });
  const reader = new ReadonlyStore(location);
  try { expect(reader.snapshot(() => reader.opportunity(f.run.run_id, "storage-review"))).toEqual(opportunity(f.run.run_id)); }
  finally { reader.close(); }
});

test("missing, omitted, or mismatched projection locations fail closed", () => {
  const a = fixture(), b = fixture(), location = a.store.readLocation();
  expect(() => new ReadonlyStore({ database: location.database, artifacts: location.artifacts })).toThrow();
  expect(() => new ReadonlyStore({ ...location, projection: b.store.readLocation().projection })).toThrow();
  a.store.close();
  rmSync(location.projection!);
  expect(() => new Store(a.directory)).toThrow();
});

for (const failure of ["receipt", "acknowledgement"] as const) test(`durable review outbox recovers ${failure} failure without duplicate events`, () => {
  const f = fixture(), location = f.store.readLocation();
  f.store.saveOpportunity(opportunity(f.run.run_id));
  const target = failure === "receipt" ? location.database : location.projection!;
  const trigger = failure === "receipt"
    ? "CREATE TRIGGER fail_review BEFORE INSERT ON projection_audit_receipts BEGIN SELECT RAISE(ABORT,'injected audit failure'); END"
    : "CREATE TRIGGER fail_review BEFORE UPDATE ON projection_audit_outbox BEGIN SELECT RAISE(ABORT,'injected audit failure'); END";
  database(target, db => db.exec(trigger));
  expect(() => f.store.resolveOpportunity(f.run.run_id, "storage-review", resolution)).toThrow("injected audit failure");
  expect(f.store.opportunity(f.run.run_id, "storage-review")?.resolution).toEqual(resolution);
  const before = f.store.eventsAfter(f.run.run_id, 0, 100).filter(event => event.type === "learning.resolved");
  expect(before.length).toBe(failure === "receipt" ? 0 : 1);
  database(target, db => db.exec("DROP TRIGGER fail_review"));
  f.store.close();
  const reopened = new Store(f.directory); stores.push(reopened);
  const retry = reopened.resolveOpportunity(f.run.run_id, "storage-review", { ...resolution, at: "2020-02-01T00:00:00.000Z" });
  expect(retry.resolution).toEqual(resolution);
  const events = reopened.eventsAfter(f.run.run_id, 0, 100).filter(event => event.type === "learning.resolved");
  expect(events.length).toBe(1);
  expect(events[0]!.summary).toBe("Recorded model-selected improvement decision");
  expect(events[0]!.details).toEqual({ opportunity_id: "storage-review", decision: "keep", revision: null, measured: false, qualification: "unmeasured_candidate" });
  database(location.database, db => expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projection_audit_receipts").get()!.n).toBe(1));
  database(location.projection!, db => expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projection_audit_outbox WHERE event_seq IS NULL").get()!.n).toBe(0));
});

test("frozen combined history is read without mutation and writer migration preserves identities", () => {
  const f = fixture();
  const value = opportunity(f.run.run_id);
  f.store.saveOpportunity(value);
  const checkpoint = f.store.beginHistoryProjection(f.run.run_id);
  const originalEvents = f.store.eventsAfter(f.run.run_id, 0, 100);
  const originalSources = f.store.historySourceChanges(f.run.run_id, 0);
  legacyCombined(f);
  const location = { database: f.store.readLocation().database, artifacts: f.store.readLocation().artifacts };
  const before = createHash("sha256").update(readFileSync(location.database)).digest("hex");
  const frozen = new ReadonlyStore(location);
  try {
    expect(frozen.opportunity(f.run.run_id, value.opportunity_id)).toEqual(value);
    expect(frozen.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  } finally { frozen.close(); }
  expect(createHash("sha256").update(readFileSync(location.database)).digest("hex")).toBe(before);
  const migrated = new Store(f.directory); stores.push(migrated);
  expect(migrated.opportunity(f.run.run_id, value.opportunity_id)).toEqual(value);
  expect(migrated.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  expect(migrated.eventsAfter(f.run.run_id, 0, 100)).toEqual(originalEvents);
  expect(migrated.historySourceChanges(f.run.run_id, 0)).toEqual(originalSources);
  expect(migrated.evidenceObjectRows(f.run.run_id, "opportunity", 0, 128)[0]!.seq).toBe(1);
});

test("migration refuses corrupt published frontiers instead of returning empty history", () => {
  const f = fixture();
  f.store.beginHistoryProjection(f.run.run_id);
  legacyCombined(f);
  database(f.store.readLocation().database, db => db.query("UPDATE history_projection_checkpoints SET payload=json_set(payload,'$.generation',1)").run());
  expect(() => new Store(f.directory)).toThrow("frontier");
});

for (const accepted of [false, true]) test(`candidate source acceptance ${accepted ? "survives a derived rollback with an exact durable receipt" : "rejects stale source before its receipt"}`, async () => {
  const f = fixture(), location = f.store.readLocation();
  // Reuse the existing storage-only source fixture; no gameplay policy or native run.
  const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run));
  const execution = historyExecution(f.store, f.run, skill);
  finishHistoryExecution(f.store, execution);
  const reader = new ReadonlyStore(location);
  let candidate: HistoryProjectionBatch | null = null;
  try {
    let checkpoint = f.store.beginHistoryProjection(f.run.run_id);
    for (let page = 0; page < 256; page++) {
      const batch = reader.snapshot(() => prepareHistoryProjectionBatch(reader, f.run.run_id, checkpoint));
      if (batch.candidates.length) { candidate = batch; break; }
      f.store.commitHistoryProjectionBatch(f.run.run_id, batch);
      checkpoint = batch.after;
      if (!batch.has_more) break;
    }
    expect(candidate).not.toBeNull();
    if (!candidate) throw new Error("Storage fixture did not reach candidate capture");
    if (accepted) {
      database(location.projection!, db => db.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON history_projection_rows WHEN NEW.collection='pending_opportunity' BEGIN SELECT RAISE(ABORT,'injected derived failure'); END"));
      expect(() => f.store.commitHistoryProjectionBatch(f.run.run_id, candidate!)).toThrow("injected derived failure");
      database(location.database, db => expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projection_publications").get()!.n).toBe(1));
      database(location.projection!, db => db.exec("DROP TRIGGER fail_capture"));
    }
    // Exercise the retained source-revision journal without violating terminal
    // execution immutability or authoring any replacement gameplay behavior.
    database(location.database, db => db.query("UPDATE events SET summary=? WHERE run_id=? AND event_seq=?")
      .run("Storage source correction after preview", f.run.run_id, candidate!.candidates[0]!.event_seqs[0]!));
    if (accepted) {
      f.store.commitHistoryProjectionBatch(f.run.run_id, candidate);
      expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(candidate.after);
    } else {
      expect(() => f.store.commitHistoryProjectionBatch(f.run.run_id, candidate!)).toThrow("current source");
      database(location.database, db => expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projection_publications").get()!.n).toBe(0));
    }
  } finally { reader.close(); }
});
