import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadonlyStore } from "../src/server/store-read.ts";
import type { Store } from "../src/server/store.ts";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import type { ImprovementOpportunity, ProgramVersionEvidence } from "../src/shared/execution-evidence.ts";
import { minecraftRunFixture, minecraftTestAdapter, skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import { finishHistoryExecution, historyExecution, historyFixture, historySpec, type HistoryFixture } from "./helpers/history-fixture.ts";

const fixtures: HistoryFixture[] = [];
const readers: ReadonlyStore[] = [];
const temporary: string[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const value = historyFixture();
  fixtures.push(value);
  return value;
}
function readerFor(store: Store) {
  const reader = new ReadonlyStore(store.readLocation());
  readers.push(reader);
  return reader;
}
function sql<T>(database: string, operation: (db: Database) => T): T {
  const db = new Database(database, { create: false, strict: true });
  try { return operation(db); } finally { db.close(true); }
}
function digest(database: string) { return createHash("sha256").update(readFileSync(database)).digest("hex"); }
function schema(database: string) {
  return sql(database, db => ({ version: db.query("PRAGMA user_version").get(), objects: db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all() }));
}
function opportunity(ref: ProgramVersionEvidence, id: string, created = "2020-01-01T00:00:00.000Z"): ImprovementOpportunity {
  return { opportunity_id: id, run_id: ref.run_id, kind: "outcome", version: ref, execution_id: `execution-${id}`, event_seqs: [], created_at: created, resolution: null };
}

describe("real existing-only readonly Store", () => {
  test("missing files and missing parent directories are never created", () => {
    const directory = mkdtempSync(join(tmpdir(), "gameharness-readonly-missing-"));
    temporary.push(directory);
    for (const root of [directory, join(directory, "missing-parent")]) {
      expect(() => new ReadonlyStore({ database: join(root, "runs.sqlite"), artifacts: join(root, "artifacts") })).toThrow();
      expect(existsSync(join(root, "runs.sqlite"))).toBe(false);
      expect(existsSync(join(root, "artifacts"))).toBe(false);
    }
    expect(readdirSync(directory)).toEqual([]);
    const empty = join(directory, "runs.sqlite");
    writeFileSync(empty, Buffer.alloc(0), { mode: 0o640 });
    const before = digest(empty);
    expect(() => new ReadonlyStore({ database: empty, artifacts: join(directory, "artifacts") })).toThrow();
    expect(digest(empty)).toBe(before);
    expect(statSync(empty).mode & 0o777).toBe(0o640);
    expect(readdirSync(directory)).toEqual(["runs.sqlite"]);
  });

  test("opening and querying do not change schema, database bytes or existing permissions", () => {
    const { directory, store, run } = fixture();
    const location = store.readLocation();
    expect(location).toEqual({ database: join(directory, "runs.sqlite"), artifacts: join(directory, "artifacts") });
    store.close();
    chmodSync(directory, 0o750);
    chmodSync(location.database, 0o640);
    chmodSync(location.artifacts, 0o710);
    const before = { schema: schema(location.database), digest: digest(location.database), modes: [directory, location.database, location.artifacts].map(file => statSync(file).mode & 0o777) };
    const reader = readerFor(store);
    expect(reader.snapshot(() => reader.getRun(run.run_id))).toEqual(run);
    reader.close();
    expect(schema(location.database)).toEqual(before.schema);
    expect(digest(location.database)).toBe(before.digest);
    expect([directory, location.database, location.artifacts].map(file => statSync(file).mode & 0o777)).toEqual(before.modes);
  });

  test("unmigrated or incomplete databases fail without repairing them", () => {
    for (const mutation of ["PRAGMA user_version=3", "PRAGMA user_version=4", "DROP TABLE execution_trace", "DROP INDEX skill_executions_ordinal",
      "DROP TABLE history_projection_checkpoints", "DROP INDEX history_projection_owner", "DROP TRIGGER history_source_execution_update"]) {
      const { store } = fixture();
      const location = store.readLocation();
      store.close();
      sql(location.database, db => db.exec(mutation));
      const before = { schema: schema(location.database), digest: digest(location.database) };
      expect(() => new ReadonlyStore(location)).toThrow();
      expect(schema(location.database)).toEqual(before.schema);
      expect(digest(location.database)).toBe(before.digest);
    }
  });

  for (const { description, name, keys, predicate } of [
    { description: "a wrong immutable hash expression", name: "evidence_opportunity_version", keys: "run_id,json_extract(payload,'$.version.run_id'),json_extract(payload,'$.version.skill_id'),json_extract(payload,'$.version.version'),json_extract(payload,'$.hash')", predicate: "kind='opportunity'" },
    { description: "a version key swapped with a top-level key", name: "evidence_opportunity_version", keys: "run_id,json_extract(payload,'$.run_id'),json_extract(payload,'$.version.skill_id'),json_extract(payload,'$.version.version'),json_extract(payload,'$.version.hash')", predicate: "kind='opportunity'" },
    { description: "a repeated version key replacing the hash key", name: "evidence_opportunity_version", keys: "run_id,json_extract(payload,'$.version.run_id'),json_extract(payload,'$.version.skill_id'),json_extract(payload,'$.version.version'),json_extract(payload,'$.version.version')", predicate: "kind='opportunity'" },
    { description: "a wrong family expression", name: "evidence_opportunity_family", keys: "run_id,json_extract(payload,'$.skill_id')", predicate: "kind='opportunity'" },
    { description: "a version index with the wrong partial predicate", name: "evidence_opportunity_version", keys: "run_id,json_extract(payload,'$.version.run_id'),json_extract(payload,'$.version.skill_id'),json_extract(payload,'$.version.version'),json_extract(payload,'$.version.hash')", predicate: "kind='death'" },
    { description: "a family index with the wrong partial predicate", name: "evidence_opportunity_family", keys: "run_id,json_extract(payload,'$.version.skill_id')", predicate: "kind='death'" },
  ]) {
    test(`readonly opening rejects ${description} without mutation or repair`, () => {
      const { directory, store } = fixture();
      const location = store.readLocation();
      store.close();
      sql(location.database, db => {
        db.exec(`DROP INDEX ${name}`);
        db.exec(`CREATE INDEX ${name} ON evidence_objects(${keys}) WHERE ${predicate}`);
      });
      chmodSync(directory, 0o750);
      chmodSync(location.database, 0o640);
      chmodSync(location.artifacts, 0o710);
      const before = {
        schema: schema(location.database), digest: digest(location.database), entries: readdirSync(directory).sort(),
        modes: [directory, location.database, location.artifacts].map(file => statSync(file).mode & 0o777),
      };
      expect(() => new ReadonlyStore(location)).toThrow();
      if (process.platform === "linux") {
        const descriptors = readdirSync("/proc/self/fd").filter(fd => {
          try { return readlinkSync(`/proc/self/fd/${fd}`) === location.database; }
          catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          }
        });
        expect(descriptors).toEqual([]);
      }
      expect(schema(location.database)).toEqual(before.schema);
      expect(digest(location.database)).toBe(before.digest);
      expect(readdirSync(directory).sort()).toEqual(before.entries);
      expect([directory, location.database, location.artifacts].map(file => statSync(file).mode & 0o777)).toEqual(before.modes);
    });
  }

  test("equivalent quoted and spaced opportunity indexes support exact consumer lookups", () => {
    const { store, run } = fixture();
    const ref = { run_id: run.run_id, skill_id: "quoted-family", version: 7, hash: "a".repeat(64) };
    const exact = opportunity(ref, "quoted-exact");
    const family = opportunity({ ...ref, version: 8, hash: "b".repeat(64) }, "quoted-family-later");
    store.saveOpportunity(exact);
    store.saveOpportunity(family);
    const location = store.readLocation();
    store.close();
    sql(location.database, db => db.exec(`
      DROP INDEX evidence_opportunity_version;
      DROP INDEX evidence_opportunity_family;
      CREATE INDEX "evidence_opportunity_version" ON "evidence_objects" (
        "run_id", json_extract ( "payload", '$.version.run_id' ),
        json_extract ( "payload", '$.version.skill_id' ),
        json_extract ( "payload", '$.version.version' ),
        json_extract ( "payload", '$.version.hash' )
      ) WHERE "kind" = 'opportunity';
      CREATE INDEX "evidence_opportunity_family" ON "evidence_objects" (
        "run_id", json_extract ( "payload", '$.version.skill_id' )
      ) WHERE "kind" = 'opportunity';
    `));
    const before = { schema: schema(location.database), digest: digest(location.database) };
    const reader = readerFor(store);
    expect(reader.latestOpportunityForVersion(ref)).toEqual(exact);
    expect(reader.latestOpportunityForFamily(run.run_id, ref.skill_id)).toEqual(family);
    expect(reader.latestOpportunityForVersion({ ...ref, hash: "c".repeat(64) })).toBeNull();
    reader.close();
    expect(schema(location.database)).toEqual(before.schema);
    expect(digest(location.database)).toBe(before.digest);
  });

  test.skipIf(process.platform !== "linux")("the real database descriptor is read-only and is released by close", () => {
    const { store, run } = fixture();
    const location = store.readLocation();
    store.close();
    const reader = readerFor(store);
    reader.getRun(run.run_id);
    const descriptors = readdirSync("/proc/self/fd").filter(fd => {
      try { return readlinkSync(`/proc/self/fd/${fd}`) === location.database; }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    });
    expect(descriptors.length).toBeGreaterThan(0);
    for (const fd of descriptors) {
      const flags = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^flags:\s+([0-7]+)$/m);
      expect(flags).not.toBeNull();
      // Linux O_ACCMODE: 0 = O_RDONLY, 1 = O_WRONLY, 2 = O_RDWR.
      expect(Number.parseInt(flags![1]!, 8) & 3).toBe(0);
    }
    reader.close();
    reader.close();
    for (const fd of descriptors) {
      let target: string | null = null;
      try { target = readlinkSync(`/proc/self/fd/${fd}`); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      expect(target).not.toBe(location.database);
    }
  });

  test("schema readiness and completed reads leave the persistent reader fresh and idle WAL unpinned", () => {
    const { store, run } = fixture();
    const reader = readerFor(store);
    const checkpoint = () => sql(store.readLocation().database, db =>
      db.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get());
    expect(checkpoint()?.busy).toBe(0);
    for (let turns = 1; turns <= 3; turns++) {
      store.saveRun({ ...run, turns });
      const event = store.event(run.run_id, "fixture.idle", `Writer commit ${turns}`);
      expect(reader.getRun(run.run_id)?.turns).toBe(turns);
      expect(reader.eventsAfter(run.run_id, event.event_seq - 1, 500)).toEqual([event]);
      expect(reader.snapshot(() => ({
        turns: reader.getRun(run.run_id)?.turns,
        last: reader.lastEventSeq(),
      }))).toEqual({ turns, last: event.event_seq });
      expect(checkpoint()?.busy).toBe(0);
    }
  });

  test("one deferred snapshot is coherent across real writer commits and does not pin idle WAL", () => {
    const { store, run } = fixture();
    const reader = readerFor(store);
    const first = store.event(run.run_id, "fixture.before", "Before snapshot");
    reader.snapshot(() => {
      expect(reader.getRun(run.run_id)?.turns).toBe(0);
      const before = reader.eventsAfter(run.run_id, 0, 500);
      store.saveRun({ ...run, turns: 9 });
      store.event(run.run_id, "fixture.during", "Writer committed while reader snapshot is open");
      expect(reader.getRun(run.run_id)?.turns).toBe(0);
      expect(reader.eventsAfter(run.run_id, 0, 500)).toEqual(before);
      expect(before.at(-1)?.event_seq).toBe(first.event_seq);
    });
    expect(reader.getRun(run.run_id)?.turns).toBe(9);
    expect(reader.snapshot(() => reader.getRun(run.run_id)?.turns)).toBe(9);
    expect(reader.eventsAfter(run.run_id, first.event_seq, 500).map(event => event.type)).toEqual(["fixture.during"]);
    expect(() => reader.snapshot(() => { reader.getRun(run.run_id); throw new Error("snapshot operation failed"); })).toThrow("snapshot operation failed");
    store.event(run.run_id, "fixture.after", "After failed snapshot");
    const checkpoint = sql(store.readLocation().database, db => db.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get());
    expect(checkpoint?.busy).toBe(0);
    expect(reader.snapshot(() => reader.eventsAfter(run.run_id, first.event_seq, 500))).toEqual(store.eventsAfter(run.run_id, first.event_seq, 500));
  });

  test("legacy usage is qualified only on read and absent historical authority remains null", async () => {
    const { store, run } = fixture();
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const execution = historyExecution(store, run, skill);
    const admitted = store.admitAction(run.run_id, "legacy-action", { kind: "look", yaw: 0, pitch: 0 }, "skill", execution.execution_id, skillAuthorityFixture(run, execution));
    const legacyRun = JSON.parse(JSON.stringify(run));
    legacyRun.usage = { input_tokens: 123, output_tokens: 17, known_cost: 0.25 };
    for (const key of ["session_id", "life_id", "native_boot_id", "space_epoch", "compatibility_hash"]) delete legacyRun[key];
    const legacyExecution = JSON.parse(JSON.stringify(execution));
    for (const key of ["entry", "session_id", "life_id", "world_id", "native_boot_id", "run_generation", "space_epoch", "source_hash", "compatibility_hash"]) delete legacyExecution[key];
    const legacyAction = JSON.parse(JSON.stringify(admitted.action.view));
    for (const key of ["session_id", "life_id", "scope", "invocation", "compatibility_hash"]) delete legacyAction[key];
    sql(store.readLocation().database, db => {
      db.query("UPDATE runs SET payload=? WHERE run_id=?").run(JSON.stringify(legacyRun), run.run_id);
      db.query("UPDATE skill_executions SET view=? WHERE run_id=? AND execution_id=?").run(JSON.stringify(legacyExecution), run.run_id, execution.execution_id);
      db.query("UPDATE actions SET view=? WHERE run_id=? AND action_id=?").run(JSON.stringify(legacyAction), run.run_id, legacyAction.action_id);
    });
    const reader = readerFor(store);
    expect(reader.getRun(run.run_id)).toEqual(store.getRun(run.run_id));
    expect(reader.getRun(run.run_id)).toMatchObject({ session_id: null, life_id: null, native_boot_id: null, space_epoch: null, compatibility_hash: null,
      usage: { uncached_input: null, cache_read: null, cache_write: null, calls: null, output: 17, legacy_input: 123, known_cost: 0.25, accounting_basis: "sdk_reported_subtotal", by_purpose: { planning: { output: null, calls: null } } } });
    expect(reader.skillExecution(run.run_id, { execution_id: execution.execution_id })).toEqual(store.skillExecution(run.run_id, { execution_id: execution.execution_id }));
    expect(reader.collectionRowsPage(run.run_id, "executions", 0, 1)).toMatchObject({
      total: 1, records: [{ execution_id: execution.execution_id, entry: null, world_id: null, source_hash: null, run_generation: null }],
    });
    expect(reader.skillExecution(run.run_id, { start_key: execution.start_key })).toMatchObject({ entry: null, world_id: null, native_boot_id: null, source_hash: null, run_generation: null });
    expect(reader.getAction(run.run_id, legacyAction.action_id)).toEqual(store.getAction(run.run_id, legacyAction.action_id));
    expect(reader.getAction(run.run_id, legacyAction.action_id)?.view).toMatchObject({ scope: null, invocation: null, compatibility_hash: null, session_id: null, life_id: null });
    expect(sql(store.readLocation().database, db => db.query<{ payload: string }, [string]>("SELECT payload FROM runs WHERE run_id=?").get(run.run_id)?.payload)).toBe(JSON.stringify(legacyRun));
  });

  test("collection SQL pages preserve canonical order, totals and bounded source hydration across writer appends", async () => {
    const { store, run } = fixture();
    const compatibility = run.compatibility_hash;
    if (!compatibility) throw new Error("Active fixture compatibility is required");
    const reader = readerFor(store);
    expect(reader.collectionRowsPage(run.run_id, "sources", 0, 1)).toEqual({ total: 0, records: [] });
    const z = await store.registerSkill(run.run_id, historySpec(run, "z", "return null; // z"));
    const a = await store.registerSkill(run.run_id, historySpec(run, "a", "return null; // a1"));
    await store.registerSkill(run.run_id, historySpec(run, "a", "return null; // a2"));
    for (const { name, source } of [
      { name: "z", source: "return null; // pz" },
      { name: "a", source: "return null; // pa1" },
      { name: "a", source: "return null; // pa2" },
    ]) {
      const spec = historySpec(run, name, source);
      await store.registerPolicy(run.run_id, { backend: "javascript", choices: null, name, source,
        card: spec.card, priority: 1, interval_ms: 1000 }, 1,
        { ...spec.validation, runtime_version: 5, api_version: 5, validator_version: 5, compatibility_hash: compatibility });
    }
    const traces = [];
    for (const skill of [z, a]) {
      const execution = historyExecution(store, run, skill);
      traces.push(store.recordTrace({ run_id: run.run_id, execution_id: execution.execution_id,
        root_execution_id: execution.root_execution_id, parent_execution_id: null,
        skill_id: skill.skill_id, version: skill.version, hash: skill.hash, session_id: run.session_id,
        life_id: run.life_id, kind: "branch", payload: skill.name })!);
      finishHistoryExecution(store, execution);
    }
    const expected = {
      sources: store.skills(run.run_id), policies: store.policies(run.run_id),
      executions: store.allSkillExecutions(run.run_id), events: store.eventsAfter(run.run_id, 0, 500), traces,
    };
    for (const collection of ["sources", "policies", "executions", "events", "traces"] as const) {
      const values = expected[collection];
      for (let index = 0; index <= values.length; index++) {
        expect(reader.collectionRowsPage(run.run_id, collection, index, 1)).toEqual({
          total: values.length, records: values.slice(index, index + 1),
        });
      }
      expect(reader.collectionRowsPage("another-run", collection, 0, 1)).toEqual({ total: 0, records: [] });
    }
    // A broken later artifact must not be opened while retrieving only an earlier row.
    writeFileSync(join(store.readLocation().artifacts, `${z.hash}.js`), "tampered later source");
    expect(reader.collectionRowsPage(run.run_id, "sources", 0, 1)).toEqual({ total: 3, records: [a] });
    expect(() => reader.collectionRowsPage(run.run_id, "sources", 2, 1)).toThrow("integrity");
    const appended = store.event(run.run_id, "fixture.page_append", "Writer append after completed page");
    const events = reader.collectionRowsPage(run.run_id, "events", expected.events.length, 1);
    expect(events).toEqual({ total: expected.events.length + 1, records: [appended] });
    expect(reader.collectionRowsPage(run.run_id, "sources", 3, 1)).toEqual({ total: 3, records: [] });
  });

  test("source integrity hashes raw bytes before UTF-8 decoding, rejects tampering and malformed hashes, and enforces run scope", async () => {
    const { directory, store, run } = fixture();
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const other = minecraftRunFixture(minecraftTestAdapter());
    store.saveRun(other);
    const reader = readerFor(store);
    expect(reader.skill(run.run_id, skill)).toEqual(store.skill(run.run_id, skill));
    expect(reader.skills(run.run_id)).toEqual(store.skills(run.run_id));
    expect(reader.namedSkill(run.run_id, skill.name, skill.version, true)).toEqual(skill);
    expect(reader.programCatalog(run.run_id, 0, 10)).toEqual(store.programCatalog(run.run_id, 0, 10));
    expect(() => reader.skill(other.run_id, skill)).toThrow();
    const original = Buffer.from([0x2f, 0x2f, 0x80]);
    const tampered = Buffer.from([0x2f, 0x2f, 0x81]);
    expect(original.toString("utf8")).toBe(tampered.toString("utf8"));
    const hash = createHash("sha256").update(original).digest("hex");
    const filename = join(directory, "artifacts", `${hash}.js`);
    writeFileSync(filename, original);
    sql(store.readLocation().database, db => db.query("UPDATE skills SET hash=? WHERE run_id=? AND skill_id=? AND version=?").run(hash, run.run_id, skill.skill_id, skill.version));
    expect(reader.skill(run.run_id, skill).source).toBe(original.toString("utf8"));
    writeFileSync(filename, tampered);
    expect(() => reader.skill(run.run_id, skill)).toThrow();
    expect(() => store.skill(run.run_id, skill)).toThrow();
    for (const malformed of ["../outside", "a".repeat(63), "G".repeat(64), `${hash}/extra`]) {
      sql(store.readLocation().database, db => db.query("UPDATE skills SET hash=? WHERE run_id=? AND skill_id=? AND version=?").run(malformed, run.run_id, skill.skill_id, skill.version));
      expect(() => reader.skill(run.run_id, skill)).toThrow();
      expect(() => store.skill(run.run_id, skill)).toThrow();
    }
  });

  test("current rows, late child actions and trace omissions have identical consumer projections", async () => {
    const { store, run } = fixture();
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const root = historyExecution(store, run, skill), child = historyExecution(store, run, skill, root);
    const action = store.admitAction(run.run_id, "late-child", { kind: "look", yaw: 0, pitch: 0 }, "skill", child.execution_id, skillAuthorityFixture(run, child)).action.view;
    const reader = readerFor(store);
    expect(reader.selectedSkillExecution(run.run_id, "current")?.execution_id).toBe(root.execution_id);
    expect(reader.selectedAction(run.run_id, "current", root.execution_id)).toEqual(action);
    action.status = "unknown";
    store.saveAction(run.run_id, action);
    store.event(run.run_id, "action.unknown", "Initial retained outcome", { action_id: action.action_id });
    finishHistoryExecution(store, child);
    finishHistoryExecution(store, root);
    // A later row replaces the initial outcome. Counters must hydrate the current row,
    // not treat the old event as an immutable action-result snapshot.
    action.status = "failed";
    action.ended_at = "2020-01-01T00:00:02.000Z";
    action.result = { status: "failed", summary: "Synthetic storage receipt; no effect success", evidence: { effect_confirmed: false, travel_distance: 7, native_action_ms: 3 } };
    store.saveAction(run.run_id, action);
    store.event(run.run_id, "action.failed", "Late durable outcome", { action_id: action.action_id });
    const omitted = store.recordTrace({ run_id: run.run_id, execution_id: child.execution_id, root_execution_id: root.execution_id,
      parent_execution_id: root.execution_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash,
      session_id: run.session_id, life_id: run.life_id, kind: "capability_result", payload: "x".repeat(30000) });
    expect(omitted?.omission?.reason).toBe("record_byte_budget");
    expect(reader.selectedSkillExecution(run.run_id, "current")).toBeNull();
    expect(reader.selectedAction(run.run_id, "current", root.execution_id)).toBeNull();
    expect(reader.selectedAction(run.run_id, "latest", root.execution_id)).toEqual(action);
    expect(reader.executionReferences(run.run_id)).toEqual(store.executionReferences(run.run_id));
    expect(reader.tracePage(run.run_id, 0, 100, root.execution_id)).toEqual(store.tracePage(run.run_id, 0, 100, root.execution_id));
    expect(reader.traceRecord(run.run_id, omitted!.trace_seq)).toEqual(store.traceRecord(run.run_id, omitted!.trace_seq));
    expect(objectiveMetrics(reader, run.run_id)).toEqual(objectiveMetrics(store, run.run_id));
    for (const metric of objectiveMetrics(reader, run.run_id)) expect(metric).toMatchObject({ outcome: "succeeded", receipted_travel_distance: 7, motion_receipts: 1, spans_ms: { native_action: 3 }, trace_complete: false });
    expect(programEvidence(reader, run.run_id)).toEqual(programEvidence(store, run.run_id));
    for (const evidence of programEvidence(reader, run.run_id)) expect(evidence).toMatchObject({ confirmed_effects: 0, evidence_status: "self_reported", verified_event_seqs: [], metrics: { trace_complete: false } });
    expect(reader.tracePage(run.run_id, 0, 100, "unrelated-root").records).toEqual([]);
  });

  test("exact lineage reads retain an older open root and child beyond the latest-100 execution snapshot", async () => {
    const { store, run } = fixture();
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const root = historyExecution(store, run, skill);
    for (let index = 0; index < 105; index++) finishHistoryExecution(store, historyExecution(store, run, skill));
    const child = historyExecution(store, run, skill, root);
    finishHistoryExecution(store, child);
    const reader = readerFor(store);
    expect(store.skillExecutions(run.run_id)).toHaveLength(100);
    expect(store.skillExecutions(run.run_id).some(execution => execution.execution_id === root.execution_id)).toBe(false);
    expect(reader.allSkillExecutions(run.run_id)).toHaveLength(107);
    expect(reader.allSkillExecutions(run.run_id)).toEqual(store.allSkillExecutions(run.run_id));
    expect(reader.skillExecution(run.run_id, { execution_id: root.execution_id })).toEqual(root);
    expect(reader.skillExecution(run.run_id, { execution_id: child.execution_id })).toEqual(child);
    expect(reader.selectedSkillExecution(run.run_id, "current")?.execution_id).toBe(root.execution_id);
    expect(reader.executionReferences(run.run_id, root.execution_id)).toEqual(store.executionReferences(run.run_id, root.execution_id));
    expect(reader.skillExecutionRows(run.run_id, 0, 256)).toEqual(store.skillExecutionRows(run.run_id, 0, 256));
    expect(objectiveMetrics(reader, run.run_id).map(metric => metric.execution_id)).toEqual(store.allSkillExecutions(run.run_id).map(execution => execution.execution_id));
    expect(reader.skillExecution("other-run", { execution_id: root.execution_id })).toBeNull();
  });

  test("exact opportunities bypass 256-row presentation limits and preserve resolved insertion order", async () => {
    const { store, run } = fixture();
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const next = await store.registerSkill(run.run_id, historySpec(run, skill.name, `${skill.source}\n// exact second version`));
    const other = minecraftRunFixture(minecraftTestAdapter());
    store.saveRun(other);
    const ref = { run_id: run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash };
    const first = opportunity(ref, "exact-old", "2099-01-01T00:00:00.000Z");
    store.saveOpportunity(first);
    for (let index = 0; index < 300; index++) store.saveOpportunity(opportunity({ ...ref, skill_id: `unrelated-${index}` }, `unrelated-${index}`));
    const latestExact = opportunity(ref, "exact-later-insert", "2001-01-01T00:00:00.000Z");
    store.saveOpportunity(latestExact);
    const resolved = store.resolveOpportunity(run.run_id, latestExact.opportunity_id, { decision: "insufficient_evidence", reason: "Storage fixture has no gameplay measurement", revision: null, event_seqs: [], measured: false, at: "2001-01-01T00:00:01.000Z" });
    const nextVersion = opportunity({ ...ref, version: next.version, hash: next.hash }, "same-family-next-version", "1999-01-01T00:00:00.000Z");
    store.saveOpportunity(nextVersion);
    store.saveOpportunity({ ...opportunity({ ...ref, run_id: other.run_id }, "mismatched-version-run"), run_id: run.run_id });
    const wrongHash = opportunity({ ...ref, hash: "f".repeat(64) }, "same-number-wrong-hash");
    store.saveOpportunity(wrongHash);
    store.saveOpportunity(opportunity({ ...ref, run_id: other.run_id }, "cross-run-newest"));
    const reader = readerFor(store);
    expect(reader.opportunity(run.run_id, first.opportunity_id)).toEqual(first);
    expect(reader.opportunity(other.run_id, first.opportunity_id)).toBeNull();
    expect(reader.opportunity(run.run_id, "missing")).toBeNull();
    expect(reader.latestOpportunityForVersion(ref)).toEqual(resolved);
    expect(reader.latestOpportunityForVersion({ ...ref, hash: "0".repeat(64) })).toBeNull();
    expect(reader.latestOpportunityForVersion({ ...ref, version: next.version, hash: next.hash })).toEqual(nextVersion);
    expect(reader.latestOpportunityForFamily(run.run_id, skill.skill_id)).toEqual(wrongHash);
    expect(reader.latestOpportunityForFamily(other.run_id, skill.skill_id)?.opportunity_id).toBe("cross-run-newest");
    expect(reader.opportunityCount(run.run_id)).toBe(305);
    expect(reader.opportunityCount("missing-run")).toBe(0);
    expect(reader.evidenceObjects(run.run_id, "opportunity")).toEqual(store.evidenceObjects(run.run_id, "opportunity"));
    expect(reader.evidenceObjectRows(run.run_id, "opportunity", 0, 256)).toEqual(store.evidenceObjectRows(run.run_id, "opportunity", 0, 256));
    expect(reader.opportunity(run.run_id, first.opportunity_id)).toEqual(store.opportunity(run.run_id, first.opportunity_id));
    expect(reader.latestOpportunityForVersion(ref)).toEqual(store.latestOpportunityForVersion(ref));
    expect(reader.latestOpportunityForFamily(run.run_id, skill.skill_id)).toEqual(store.latestOpportunityForFamily(run.run_id, skill.skill_id));
    const plans = sql(store.readLocation().database, db => [
      db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT payload FROM evidence_objects WHERE run_id=? AND kind='opportunity' AND object_key=?").all(run.run_id, first.opportunity_id),
      db.query<{ detail: string }, [string, string, string, number, string]>("EXPLAIN QUERY PLAN SELECT payload FROM evidence_objects WHERE run_id=? AND kind='opportunity' AND json_extract(payload,'$.version.run_id')=? AND json_extract(payload,'$.version.skill_id')=? AND json_extract(payload,'$.version.version')=? AND json_extract(payload,'$.version.hash')=? ORDER BY rowid DESC LIMIT 1").all(ref.run_id, ref.run_id, ref.skill_id, ref.version, ref.hash),
      db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT payload FROM evidence_objects WHERE run_id=? AND kind='opportunity' AND json_extract(payload,'$.version.skill_id')=? ORDER BY rowid DESC LIMIT 1").all(run.run_id, skill.skill_id),
    ]);
    for (const plan of plans) {
      expect(plan.some(row => row.detail.includes("SEARCH"))).toBe(true);
      expect(plan.some(row => row.detail.includes("SCAN evidence_objects") || row.detail.includes("TEMP B-TREE"))).toBe(false);
    }
    expect(plans[1]!.some(row => row.detail.includes("evidence_opportunity_version"))).toBe(true);
    expect(plans[2]!.some(row => row.detail.includes("evidence_opportunity_family"))).toBe(true);
  });

  test("cached statements and the connection close idempotently, including after a failed snapshot", async () => {
    const { store, run } = fixture();
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const execution = historyExecution(store, run, skill);
    finishHistoryExecution(store, execution);
    const reader = readerFor(store);
    reader.snapshot(() => {
      reader.getRun(run.run_id); reader.getAction(run.run_id, "absent"); reader.eventsAfter(run.run_id, 0, 500);
      reader.skills(run.run_id); reader.skill(run.run_id, skill); reader.namedSkill(run.run_id, skill.name);
      reader.programCatalog(run.run_id, 0, 10); reader.allSkillExecutions(run.run_id);
      reader.skillExecution(run.run_id, { start_key: execution.start_key }); reader.skillExecutionRows(run.run_id, 0, 10);
      reader.selectedSkillExecution(run.run_id, "latest"); reader.executionReferences(run.run_id);
      reader.selectedAction(run.run_id, "latest"); reader.tracePage(run.run_id); reader.traceRecord(run.run_id, 1);
      reader.evidenceObjects(run.run_id, "death"); reader.evidenceObjectRows(run.run_id, "opportunity", 0, 10);
      reader.opportunity(run.run_id, "absent"); reader.latestOpportunityForFamily(run.run_id, skill.skill_id);
      reader.latestOpportunityForVersion({ run_id: run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash }); reader.opportunityCount(run.run_id);
    });
    expect(() => reader.snapshot(() => { reader.eventsAfter(run.run_id, 0, 1); throw new Error("abort read"); })).toThrow("abort read");
    reader.close();
    expect(() => reader.close()).not.toThrow();
    expect(() => reader.getRun(run.run_id)).toThrow();
    expect(() => reader.snapshot(() => reader.eventsAfter(run.run_id, 0, 1))).toThrow();
    expect(store.getRun(run.run_id)).toEqual(run);
    const reopened = readerFor(store);
    expect(reopened.skill(run.run_id, skill)).toEqual(skill);
  });
});
