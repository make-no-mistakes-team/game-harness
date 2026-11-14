import { constants, Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StoreDatabase, STORE_OPPORTUNITY_INDEXES } from "./store-database.ts";
import { assertProjectionCheckpoint, assertProjectionRow, HISTORY_PROJECTION_SCHEMA_SQL, type ProjectionRow } from "./history-projection.ts";

const tables = ["history_projection_rows", "history_projection_checkpoints", "history_projection_generations", "history_opportunity_visibility", "history_opportunity_updates"] as const;
interface Binding { source_id: string; projection_id: string; ready: number }

/** A separately writable derived ledger. Its binding is committed before any effects. */
export class ProjectionStorage {
  readonly database: StoreDatabase;
  readonly sourceId: string;
  readonly projectionId: string;

  constructor(control: StoreDatabase, sourceFilename: string, readonly filename: string) {
    const sourceVersion = control.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    const bound = control.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name='projection_storage_binding'").get();
    if (!bound && sourceVersion >= 8) throw new Error("Separated source ledger has lost its projection identity");
    if (!bound) control.transaction(() => control.exec(`CREATE TABLE projection_storage_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL,projection_id TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1))) STRICT;
      CREATE TABLE IF NOT EXISTS projection_publications(publication_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,source_through INTEGER NOT NULL,batch_hash TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS projection_audit_receipts(receipt_id TEXT PRIMARY KEY,event_seq INTEGER NOT NULL UNIQUE REFERENCES events(event_seq),payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;`)).immediate();
    let binding = control.query<Binding, []>("SELECT source_id,projection_id,ready FROM projection_storage_binding WHERE singleton=1").get();
    if (!binding) {
      if (sourceVersion >= 8) throw new Error("Separated source ledger has an empty projection identity");
      if (existsSync(filename)) throw new Error("Unbound projection database exists; refusing ambiguous migration");
      binding = { source_id: randomUUID(), projection_id: randomUUID(), ready: 0 };
      control.query("INSERT INTO projection_storage_binding(singleton,source_id,projection_id,ready) VALUES(1,?,?,0)").run(binding.source_id, binding.projection_id);
    } else if (binding.ready && !existsSync(filename)) {
      throw new Error("Bound projection database is missing; history cannot be reconstructed implicitly");
    }
    this.sourceId = binding.source_id;
    this.projectionId = binding.projection_id;
    // Bun's object options cannot enable URI handling. It is required for the
    // readonly ATTACH below; all projection statements use typed positional binds.
    const flags = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_URI |
      (binding.ready ? 0 : constants.SQLITE_OPEN_CREATE);
    this.database = new StoreDatabase(new Database(filename, flags));
    chmodSync(filename, 0o600);
    try {
      this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const existing = this.database.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name='projection_binding'").get();
      if (existing) {
        const saved = this.database.query<Binding, []>("SELECT source_id,projection_id,ready FROM projection_binding WHERE singleton=1").get();
        if (!saved || saved.source_id !== binding.source_id || saved.projection_id !== binding.projection_id || saved.ready !== 1)
          throw new Error("Projection database binding is corrupt or belongs to another source ledger");
      } else if (binding.ready) throw new Error("Bound projection database has no identity");
      if (!binding.ready) this.migrate(control, sourceFilename, !!existing);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private migrate(control: StoreDatabase, sourceFilename: string, copied: boolean): void {
    // ATTACH is strictly readonly: this connection can never become a second control writer.
    this.database.query("ATTACH DATABASE ? AS legacy").run(`${pathToFileURL(sourceFilename).href}?mode=ro`);
    try {
      this.database.transaction(() => {
        if (!copied) {
          this.database.exec(`CREATE TABLE evidence_objects(run_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='opportunity'),object_key TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(run_id,kind,object_key)) STRICT;`);
          // Copy before installing opportunity triggers, preserving every original row/change identity.
          this.database.exec(HISTORY_PROJECTION_SCHEMA_SQL.replace(/CREATE TRIGGER[\s\S]*$/, ""));
          this.database.exec("INSERT INTO evidence_objects(rowid,run_id,kind,object_key,payload) SELECT rowid,run_id,kind,object_key,payload FROM legacy.evidence_objects WHERE kind='opportunity'");
          for (const table of tables) this.database.exec(`INSERT INTO ${table} SELECT * FROM legacy.${table}`);
          this.database.exec("INSERT INTO sqlite_sequence(name,seq) SELECT name,seq FROM legacy.sqlite_sequence WHERE name='history_opportunity_updates' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='history_opportunity_updates')");
          this.database.exec("UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM legacy.sqlite_sequence WHERE name='history_opportunity_updates'),0)) WHERE name='history_opportunity_updates'");
          for (const index of STORE_OPPORTUNITY_INDEXES) this.database.exec(index.sql);
          this.database.exec(HISTORY_PROJECTION_SCHEMA_SQL);
          this.database.exec(`CREATE TABLE projection_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL,projection_id TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready=1)) STRICT;
            CREATE TABLE projection_audit_outbox(outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,receipt_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),event_seq INTEGER) STRICT;
            CREATE INDEX projection_audit_pending ON projection_audit_outbox(outbox_seq) WHERE event_seq IS NULL;`);
          this.database.query("INSERT INTO projection_binding VALUES(1,?,?,1)").run(this.sourceId, this.projectionId);
          this.database.exec("PRAGMA user_version=1");
        }
        for (const table of tables) {
          const mismatch = this.database.query<{ mismatch: number }, []>(`SELECT 1 AS mismatch FROM (SELECT * FROM ${table} EXCEPT SELECT * FROM legacy.${table}) UNION ALL SELECT 1 FROM (SELECT * FROM legacy.${table} EXCEPT SELECT * FROM ${table}) LIMIT 1`).get();
          if (mismatch) throw new Error(`Projection migration differs from original ${table}`);
        }
        const mismatch = this.database.query<{ mismatch: number }, []>("SELECT 1 AS mismatch FROM (SELECT rowid,* FROM evidence_objects EXCEPT SELECT rowid,* FROM legacy.evidence_objects WHERE kind='opportunity') UNION ALL SELECT 1 FROM (SELECT rowid,* FROM legacy.evidence_objects WHERE kind='opportunity' EXCEPT SELECT rowid,* FROM evidence_objects) LIMIT 1").get();
        if (mismatch) throw new Error("Projection migration differs from original opportunities");
        for (const row of this.database.query<{ payload: string }, []>("SELECT payload FROM history_projection_checkpoints").iterate()) assertProjectionCheckpoint(JSON.parse(row.payload));
        for (const row of this.database.query<{ collection: ProjectionRow["collection"]; object_key: string; owner_id: string | null; source_id: string | null; order_seq: number; tag: string | null; payload: string }, []>("SELECT collection,object_key,owner_id,source_id,order_seq,tag,payload FROM history_projection_rows WHERE deleted=0").iterate()) {
          assertProjectionRow({ collection: row.collection, key: row.object_key, owner_id: row.owner_id, source_id: row.source_id, order_seq: row.order_seq, tag: row.tag, value: JSON.parse(row.payload) });
        }
        if (this.database.query<{ bad: number }, []>("SELECT 1 AS bad FROM evidence_objects WHERE json_extract(payload,'$.run_id') IS NOT run_id OR json_extract(payload,'$.opportunity_id') IS NOT object_key LIMIT 1").get()) throw new Error("Corrupt opportunity identity during migration");
        if (this.database.query<{ bad: number }, []>("SELECT 1 AS bad FROM evidence_objects e WHERE NOT EXISTS(SELECT 1 FROM legacy.runs r WHERE r.run_id=e.run_id) LIMIT 1").get()) throw new Error("Orphan opportunity during migration");
        if (this.database.query<{ bad: number }, []>(`SELECT 1 AS bad FROM history_projection_checkpoints c WHERE json_extract(c.payload,'$.generation')>0 AND NOT EXISTS(SELECT 1 FROM history_projection_generations g WHERE g.run_id=c.run_id AND g.generation=json_extract(c.payload,'$.generation') AND g.revision=json_extract(c.payload,'$.published_revision') AND g.source_through=json_extract(c.payload,'$.source_through') AND g.metric_change_seq=json_extract(c.payload,'$.published_metric_change_seq')) LIMIT 1`).get()) throw new Error("Corrupt published projection frontier during migration");
      }).immediate();
    } finally {
      this.database.exec("DETACH DATABASE legacy");
    }
    // A crash before this commit repeats the exact comparison, never an empty rebuild.
    control.transaction(() => {
      control.exec("DROP TRIGGER IF EXISTS history_opportunity_insert; DROP TRIGGER IF EXISTS history_opportunity_update;");
      for (const table of tables) control.exec(`DROP TABLE ${table}`);
      control.exec("DELETE FROM evidence_objects WHERE kind='opportunity'; DROP INDEX IF EXISTS evidence_opportunity_version; DROP INDEX IF EXISTS evidence_opportunity_family;");
      control.query("UPDATE projection_storage_binding SET ready=1 WHERE singleton=1 AND source_id=? AND projection_id=? AND ready=0").run(this.sourceId, this.projectionId);
      control.exec("PRAGMA user_version=8");
    }).immediate();
  }
}

export function requireProjectionBinding(control: StoreDatabase, projection: StoreDatabase): void {
  for (const [database, table, required, primary] of [
    [control, "projection_storage_binding", ["singleton", "source_id", "projection_id", "ready"], ["singleton"]],
    [control, "projection_publications", ["publication_id", "run_id", "source_through", "batch_hash"], ["publication_id"]],
    [control, "projection_audit_receipts", ["receipt_id", "event_seq", "payload"], ["receipt_id"]],
    [control, "evidence_objects", ["run_id", "kind", "object_key", "payload"], ["run_id", "kind", "object_key"]],
    [projection, "projection_binding", ["singleton", "source_id", "projection_id", "ready"], ["singleton"]],
    [projection, "projection_audit_outbox", ["outbox_seq", "receipt_id", "run_id", "payload", "event_seq"], ["outbox_seq"]],
  ] as const) {
    const columns = database.query<{ name: string; type: string; pk: number }, []>(`PRAGMA table_info(${table})`).all();
    const integer = new Set(["singleton", "ready", "source_through", "event_seq", "outbox_seq"]);
    const key = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
    if (required.some(name => !columns.some(column => column.name === name && column.type === (integer.has(name) ? "INTEGER" : "TEXT"))) ||
      key.length !== primary.length || key.some((column, index) => column.name !== primary[index]))
      throw new Error(`Corrupt projection storage schema ${table}`);
  }
  const pending = projection.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE type='index' AND name='projection_audit_pending'").get();
  if (pending?.sql.replace(/\s+/g, " ").trim() !== "CREATE INDEX projection_audit_pending ON projection_audit_outbox(outbox_seq) WHERE event_seq IS NULL")
    throw new Error("Corrupt bounded projection audit index");
  const base = control.query<Binding, []>("SELECT source_id,projection_id,ready FROM projection_storage_binding WHERE singleton=1").get();
  const derived = projection.query<Binding, []>("SELECT source_id,projection_id,ready FROM projection_binding WHERE singleton=1").get();
  if (!base || !derived || base.ready !== 1 || derived.ready !== 1 || base.source_id !== derived.source_id || base.projection_id !== derived.projection_id ||
    projection.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== 1)
    throw new Error("Projection location is not bound to this authoritative source ledger");
}
