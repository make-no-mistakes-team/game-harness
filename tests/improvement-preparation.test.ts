import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import type { HistoryQuery, HistoryQueryClient, HistoryQueryOptions, HistoryResult } from "../src/server/history-protocol.ts";
import type { HistoryProjectionBatch } from "../src/server/history-projection.ts";
import { HISTORY_PROJECTION_SCHEMA_SQL } from "../src/server/history-projection.ts";
import { Store } from "../src/server/store.ts";
import { STORE_OPPORTUNITY_INDEXES } from "../src/server/store-database.ts";
import { readImprovementFeedback } from "../src/server/program-feedback.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { executionScopeFixture } from "./helpers/adapter-contract.ts";
import { finishHistoryExecution, historyExecution, historyFixture, historySpec } from "./helpers/history-fixture.ts";

const options = (): HistoryQueryOptions => ({ deadlineHostMs: performance.now() + 30_000 });

/** Intercepts actual child results to exercise writer changes across the await boundary. */
function interceptReader(reader: HistoryReader, received: (query: Extract<HistoryQuery, { kind: "projection_batch" }>, result: HistoryProjectionBatch) => void): HistoryQueryClient {
  return {
    async query<Q extends HistoryQuery>(query: Q, queryOptions: HistoryQueryOptions): Promise<HistoryResult<Q>> {
      const result = await reader.query(query, queryOptions);
      if (query.kind === "projection_batch") received(query, result as HistoryProjectionBatch);
      return result;
    },
    cancelRun: (runId) => reader.cancelRun(runId),
    close: () => reader.close(),
  };
}

test("preparation persists exact opportunities beyond 256, fixes one through boundary, and retries without resetting resolutions", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  let reader: HistoryReader | undefined;
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const seed = historyExecution(store, run, skill);
    finishHistoryExecution(store, seed);
    let lastId = seed.execution_id;
    const outcomes: { type: string; summary: string; details: { execution_id: string } }[] = [];
    // Storage-only historical corpus: avoid hundreds of FULL durability commits
    // while retaining real candidate discovery, writer persistence and resolution.
    const database = new Database(store.readLocation().database, { readwrite: true, create: false, strict: true });
    try {
      const row = database.query<{ admission_ordinal: number; request: string; view: string }, [string, string]>(
        "SELECT admission_ordinal,request,view FROM skill_executions WHERE run_id=? AND execution_id=?",
      ).get(run.run_id, seed.execution_id)!;
      const insert = database.query(
        "INSERT INTO skill_executions(run_id,execution_id,admission_ordinal,start_key,skill_id,version,parent_execution_id,root_execution_id,fingerprint,request,view) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)",
      );
      database.transaction(() => {
        for (let index = 1; index < 273; index++) {
          const id = crypto.randomUUID(), key = crypto.randomUUID();
          const identity = JSON.parse(row.request);
          identity.request.start_key = key;
          const request = JSON.stringify(identity);
          const view = { ...JSON.parse(row.view), execution_id: id, root_execution_id: id, start_key: key };
          insert.run(run.run_id, id, row.admission_ordinal + index, key, skill.skill_id, skill.version,
            id, new Bun.CryptoHasher("sha256").update(request).digest("hex"), request, JSON.stringify(view));
          outcomes.push({ type: "skill.closed", summary: "Storage-only historical outcome", details: { execution_id: id } });
          lastId = id;
        }
      })();
    } finally { database.close(true); }
    store.appendEvents(run.run_id, outcomes);
    reader = new HistoryReader(store.readLocation());
    const through = store.historySourceHighwater(run.run_id);
    let pages = 0;
    let lateId = "";
    const client = interceptReader(reader, (_query, result) => {
      expect(result.candidates.length).toBeLessThanOrEqual(16);
      if (pages++ === 0) {
        const late = historyExecution(store, run, skill);
        finishHistoryExecution(store, late);
        lateId = late.execution_id;
      }
    });
    const learning = new ImprovementLearning(store, client);
    await learning.prepareFeedback(run.run_id, options());
    expect(pages).toBeGreaterThan(16);
    expect(store.historyProjectionGeneration(run.run_id)).toMatchObject({
      source_through: through, has_pending: true,
    });
    expect(store.opportunityCount(run.run_id)).toBe(273);
    const rows = store.evidenceObjectRows<{ opportunity_id: string; execution_id: string }>(run.run_id, "opportunity", 0, 300);
    const beyond = rows.find((row) => row.value.execution_id === lastId)!;
    expect(beyond).toBeDefined();
    expect(rows.some((row) => row.value.execution_id === lateId)).toBe(false);
    const decision = { decision: "keep" as const, reason: "Retain the exact descriptive outcome", revision: null, event_seqs: [] };
    const resolved = await learning.resolve(run.run_id, beyond.value.opportunity_id, decision);
    expect(await learning.resolve(run.run_id, beyond.value.opportunity_id, decision)).toEqual(resolved);
    await expect(learning.resolve(run.run_id, beyond.value.opportunity_id, { ...decision, reason: "Changed retry" })).rejects.toThrow();
    await new ImprovementLearning(store, reader).prepareFeedback(run.run_id, options());
    expect(store.opportunityCount(run.run_id)).toBe(274);
    expect(store.opportunity(run.run_id, beyond.value.opportunity_id)).toEqual(resolved);
    expect(readImprovementFeedback(store, run.run_id, undefined, 16).has_more).toBe(true);
  } finally {
    try { await reader?.close(); } finally { fixture.close(); }
  }
}, 180_000);

for (const changed of ["status", "version"] as const) {
  test(`preparation rejects a candidate after its current execution ${changed} changes during the child query`, async () => {
    const fixture = historyFixture(), { store, run } = fixture;
    let reader: HistoryReader | undefined;
    try {
      const skill = await store.registerSkill(run.run_id, historySpec(run));
      const revised = await store.registerSkill(run.run_id, historySpec(run, skill.name, 'return {status:"blocked",summary:"Another source",result:null};'));
      const view = historyExecution(store, run, skill);
      finishHistoryExecution(store, view);
      reader = new HistoryReader(store.readLocation());
      let changedCurrent = false;
      const client = interceptReader(reader, (_query, batch) => {
        if (!batch.candidates.length || changedCurrent) return;
        changedCurrent = true;
        if (changed === "status") view.status = "failed";
        else { view.version = revised.version; view.source_hash = revised.hash; }
        const db = new Database(store.readLocation().database);
        try {
          db.query("UPDATE skill_executions SET version=?,view=? WHERE run_id=? AND execution_id=?")
            .run(view.version, JSON.stringify(view), run.run_id, view.execution_id);
        } finally { db.close(); }
      });
      await expect(new ImprovementLearning(store, client).prepareFeedback(run.run_id, options())).rejects.toMatchObject({ code: "conflict" });
      expect(changedCurrent).toBe(true);
      expect(store.opportunityCount(run.run_id)).toBe(0);
      await new ImprovementLearning(store, reader).prepareFeedback(run.run_id, options());
      expect(store.opportunityCount(run.run_id)).toBe(1);
      const opportunity = readImprovementFeedback(store, run.run_id).opportunities[0]!;
      expect(opportunity.version.version).toBe(changed === "version" ? revised.version : skill.version);
      expect(opportunity.kind).toBe(changed === "status" ? "failure" : "outcome");
    } finally {
      try { await reader?.close(); } finally { fixture.close(); }
    }
  });
}

for (const cancelled of ["before_query", "after_query", "deadline", "deadline_after_query"] as const) {
  test(`preparation applies no further candidates after ${cancelled}`, async () => {
    const fixture = historyFixture(), { store, run } = fixture;
    let reader: HistoryReader | undefined;
    try {
      const skill = await store.registerSkill(run.run_id, historySpec(run));
      for (let index = 0; index < 3; index++) finishHistoryExecution(store, historyExecution(store, run, skill));
      reader = new HistoryReader(store.readLocation());
      const controller = new AbortController();
      const queryOptions = { ...options(), signal: controller.signal };
      let queryCount = 0;
      const client = interceptReader(reader, () => {
        queryCount++;
        if (cancelled === "after_query") controller.abort();
        if (cancelled === "deadline_after_query") queryOptions.deadlineHostMs = performance.now() - 1;
      });
      if (cancelled === "before_query") controller.abort();
      if (cancelled === "deadline") queryOptions.deadlineHostMs = performance.now() - 1;
      await expect(new ImprovementLearning(store, client).prepareFeedback(run.run_id, queryOptions)).rejects.toMatchObject({
        code: cancelled.startsWith("deadline") ? "history_deadline" : "history_cancelled",
      });
      expect(store.opportunityCount(run.run_id)).toBe(0);
      expect(queryCount).toBe(cancelled === "before_query" || cancelled === "deadline" ? 0 : 1);
    } finally {
      try { await reader?.close(); } finally { fixture.close(); }
    }
  });
}

test("writer binding lookup distinguishes absent and bound-null, verifies identity, and never reselects on retry", () => {
  const fixture = historyFixture(), { store, run } = fixture;
  try {
    const input = { tool: "program_write", name: "exact" };
    expect(store.lookupToolCallBinding(run.run_id, "call", input)).toEqual({ found: false });
    let selections = 0;
    expect(store.bindToolCall(run.run_id, "call", input, () => { selections++; return null; })).toBeNull();
    expect(store.lookupToolCallBinding(run.run_id, "call", input)).toEqual({ found: true, value: null });
    expect(store.bindToolCall(run.run_id, "call", input, () => { selections++; return "new-opportunity"; })).toBeNull();
    expect(selections).toBe(1);
    expect(() => store.lookupToolCallBinding(run.run_id, "call", { ...input, name: "changed" })).toThrow("different decision");
    expect(() => store.bindToolCall(run.run_id, "call", { ...input, name: "changed" }, () => "replacement")).toThrow("different decision");
  } finally { fixture.close(); }
});

test("measured revision lookup retains exact version, dispatch, and terminal-status criteria", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const revised = await store.registerSkill(run.run_id, historySpec(run, skill.name, 'return {status:"blocked",summary:"Revision",result:null};'));
    const view = historyExecution(store, run, skill);
    expect(store.hasMeasuredSkillExecution(run.run_id, skill)).toBe(false);
    const undispatched = store.admitSkill(run.run_id, {
      entry: "run", skill_id: skill.skill_id, version: skill.version, start_key: "never-dispatched",
      ...executionScopeFixture(run), args: null, limits: { ...DEFAULT_SKILL_LIMITS },
    }).view;
    undispatched.status = "cancelled"; undispatched.ended_at = "2020-01-01T00:00:01.000Z";
    store.updateSkillExecution(undispatched, "skill.closed", "Never dispatched");
    expect(store.hasMeasuredSkillExecution(run.run_id, skill)).toBe(false);
    view.status = "cancelled"; view.ended_at = "2020-01-01T00:00:01.000Z";
    store.updateSkillExecution(view, "skill.closed", "Dispatched and cancelled");
    expect(store.hasMeasuredSkillExecution(run.run_id, skill)).toBe(true);
    expect(store.hasMeasuredSkillExecution(run.run_id, revised)).toBe(false);
    expect(store.hasMeasuredSkillExecution("another-run", skill)).toBe(false);
  } finally { fixture.close(); }
});

for (const fault of ["derived", "opportunity"] as const) {
test(`a failed checkpoint commit after ${fault} writes rolls back atomically and resumes exactly once after reopen`, async () => {
  const fixture = historyFixture(), { run, directory } = fixture;
  let store = fixture.store;
  let reader: HistoryReader | undefined;
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    for (let index = 0; index < 3; index++)
      finishHistoryExecution(store, historyExecution(store, run, skill));
    let before: HistoryProjectionBatch["before"] | undefined;
    let rowsBefore = 0, updatesBefore = 0, opportunitiesBefore = 0;
    const database = new Database(store.readLocation().projection!);
    try {
      database.exec(`CREATE TRIGGER reject_history_batch AFTER INSERT ON ${fault === "derived" ? "history_projection_rows" : "evidence_objects"}
        ${fault === "opportunity" ? "WHEN NEW.kind='opportunity'" : ""}
        BEGIN SELECT RAISE(ABORT,'history batch durability fault'); END`);
    } finally { database.close(true); }
    reader = new HistoryReader(store.readLocation());
    const client = interceptReader(reader, (_query, batch) => {
      before = batch.before;
      const db = new Database(store.readLocation().projection!, { readonly: true });
      try {
        rowsBefore = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM history_projection_rows").get()!.count;
        updatesBefore = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM history_opportunity_updates").get()!.count;
      } finally { db.close(true); }
      opportunitiesBefore = store.opportunityCount(run.run_id);
    });
    await expect(new ImprovementLearning(store, client).prepareFeedback(run.run_id, options())).rejects.toThrow("history batch durability fault");
    expect(before).toBeDefined();
    expect(store.opportunityCount(run.run_id)).toBe(opportunitiesBefore);
    expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(before!);
    const repair = new Database(store.readLocation().projection!);
    try {
      expect(repair.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM history_projection_rows").get()!.count).toBe(rowsBefore);
      expect(repair.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM history_opportunity_updates").get()!.count).toBe(updatesBefore);
      repair.exec("DROP TRIGGER reject_history_batch");
    } finally { repair.close(true); }
    await reader.close();
    store.close();
    store = new Store(directory);
    reader = new HistoryReader(store.readLocation());
    const learning = new ImprovementLearning(store, reader);
    await learning.prepareFeedback(run.run_id, options());
    const committed = store.historyProjectionCheckpoint(run.run_id)!;
    expect(store.historyProjectionGeneration(run.run_id)?.source_through).toBe(store.historySourceHighwater(run.run_id));
    expect(store.opportunityCount(run.run_id)).toBe(3);
    await learning.prepareFeedback(run.run_id, options());
    expect(store.opportunityCount(run.run_id)).toBe(3);
    expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(committed);
  } finally {
    try { await reader?.close(); } finally { store.close(); fixture.close(); }
  }
});
}

test("an execution change reconsiders already consumed outcome events without changing a resolved opportunity", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  let reader: HistoryReader | undefined;
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const execution = historyExecution(store, run, skill);
    const historical = store.event(run.run_id, "skill.closed", "Early retained report", { execution_id: execution.execution_id });
    reader = new HistoryReader(store.readLocation());
    const learning = new ImprovementLearning(store, reader);
    await learning.prepareFeedback(run.run_id, options());
    const first = store.evidenceObjectRows<{ opportunity_id: string; kind: string }>(run.run_id, "opportunity", 0, 10);
    expect(first.map(row => row.value.kind)).toEqual(["failure"]);
    const resolved = await learning.resolve(run.run_id, first[0]!.value.opportunity_id,
      { decision: "keep", reason: "Retain the earlier observation", revision: null, event_seqs: [historical.event_seq] });
    finishHistoryExecution(store, execution);
    await learning.prepareFeedback(run.run_id, options());
    const rows = store.evidenceObjectRows<{ kind: string; event_seqs: number[] }>(run.run_id, "opportunity", 0, 10);
    expect(rows.map(row => row.value.kind)).toEqual(["failure", "outcome"]);
    expect(rows[1]!.value.event_seqs).toEqual([historical.event_seq]);
    expect(store.opportunity(run.run_id, resolved.opportunity_id)).toEqual(resolved);
    await learning.prepareFeedback(run.run_id, options());
    expect(store.opportunityCount(run.run_id)).toBe(2);
  } finally {
    try { await reader?.close(); } finally { fixture.close(); }
  }
});

test("two readers cannot publish the same checkpoint twice or overwrite the winner's decision", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  const readers: HistoryReader[] = [];
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    finishHistoryExecution(store, historyExecution(store, run, skill));
    while (!store.advanceHistorySourceBootstrap(128).complete) { /* Source keys precede child previews. */ }
    const checkpoint = store.beginHistoryProjection(run.run_id);
    readers.push(new HistoryReader(store.readLocation()), new HistoryReader(store.readLocation()));
    const [first, second] = await Promise.all(readers.map(reader =>
      reader.query({ kind: "projection_batch", run_id: run.run_id, checkpoint }, options())));
    store.commitHistoryProjectionBatch(run.run_id, first!);
    await new ImprovementLearning(store, readers[0]!).prepareFeedback(run.run_id, options());
    const opportunity = store.evidenceObjectRows<{ opportunity_id: string }>(run.run_id, "opportunity", 0, 10)[0]!.value;
    const learning = new ImprovementLearning(store, readers[0]!);
    const resolved = await learning.resolve(run.run_id, opportunity.opportunity_id,
      { decision: "keep", reason: "Winner's immutable decision", revision: null, event_seqs: [] });
    expect(() => store.commitHistoryProjectionBatch(run.run_id, second!)).toThrow();
    expect(store.opportunityCount(run.run_id)).toBe(1);
    expect(store.opportunity(run.run_id, resolved.opportunity_id)).toEqual(resolved);
  } finally {
    try { await Promise.all(readers.map(reader => reader.close())); } finally { fixture.close(); }
  }
});

test("schema4 history bootstraps once from the full ledger and retains resolved outcomes across migration", async () => {
  const fixture = historyFixture(), { run, directory } = fixture;
  let store = fixture.store;
  let reader: HistoryReader | undefined;
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const execution = historyExecution(store, run, skill);
    finishHistoryExecution(store, execution);
    reader = new HistoryReader(store.readLocation());
    const learning = new ImprovementLearning(store, reader);
    await learning.prepareFeedback(run.run_id, options());
    const opportunity = store.latestOpportunityForVersion({ run_id: run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash })!;
    const resolved = await learning.resolve(run.run_id, opportunity.opportunity_id,
      { decision: "keep", reason: "Keep the migrated immutable decision", revision: null, event_seqs: [] });
    await reader.close();
    const location = store.readLocation();
    store.close();
    const database = new Database(location.database);
    try {
      // Schema4 predates the separate derived ledger. Reconstruct the combined
      // storage, including the real resolved opportunity, before removing the
      // later source/projection schema.
      database.query("ATTACH DATABASE ? AS derived").run(location.projection!);
      database.transaction(() => {
        database.exec(HISTORY_PROJECTION_SCHEMA_SQL.replace(/CREATE TRIGGER[\s\S]*$/, ""));
        database.exec("INSERT INTO evidence_objects(rowid,run_id,kind,object_key,payload) SELECT rowid,run_id,kind,object_key,payload FROM derived.evidence_objects");
        for (const table of [
          "history_projection_rows",
          "history_projection_checkpoints",
          "history_projection_generations",
          "history_opportunity_visibility",
          "history_opportunity_updates",
        ])
          database.exec(`INSERT INTO ${table} SELECT * FROM derived.${table}`);
        database.exec(HISTORY_PROJECTION_SCHEMA_SQL);
        for (const index of STORE_OPPORTUNITY_INDEXES) database.exec(index.sql);
        database.exec("DROP TABLE projection_storage_binding; DROP TABLE projection_publications; DROP TABLE projection_audit_receipts");
      })();
      database.exec("DETACH DATABASE derived");
      const objects = database.query<{ type: string; name: string }, []>(
        `SELECT type,name FROM sqlite_schema
          WHERE type IN ('trigger','table') AND
            (name LIKE 'history_source_%' OR name LIKE 'history_projection_%' OR name LIKE 'history_opportunity_%')
          ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END`,
      ).all();
      expect(objects.some(object => object.name === "history_projection_rows")).toBe(true);
      expect(objects.some(object => object.name === "history_source_versions")).toBe(true);
      for (const object of objects)
        database.exec(`DROP ${object.type.toUpperCase()} "${object.name.replaceAll('"', '""')}"`);
      database.exec("PRAGMA user_version=4");
    } finally { database.close(true); }
    rmSync(location.projection!);
    for (const suffix of ["-wal", "-shm"])
      rmSync(location.projection! + suffix, { force: true });
    store = new Store(directory);
    expect(store.skillExecution(run.run_id, { execution_id: execution.execution_id })).toEqual(execution);
    expect(store.eventsAfter(run.run_id, 0, 500).some(event => event.type === "skill.closed")).toBe(true);
    expect(store.historyProjectionCheckpoint(run.run_id)).toBeNull();
    reader = new HistoryReader(store.readLocation());
    await new ImprovementLearning(store, reader).prepareFeedback(run.run_id, options());
    const after = store.historyProjectionCheckpoint(run.run_id)!;
    expect(store.historyProjectionGeneration(run.run_id)?.source_through).toBe(store.historySourceHighwater(run.run_id));
    expect(store.opportunityCount(run.run_id)).toBe(1);
    expect(store.opportunity(run.run_id, resolved.opportunity_id)).toEqual(resolved);
    await reader.close();
    store.close();
    store = new Store(directory);
    expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(after);
    expect(store.opportunity(run.run_id, resolved.opportunity_id)).toEqual(resolved);
  } finally {
    try { await reader?.close(); } finally { store.close(); fixture.close(); }
  }
});

test("waiting preparations keep independent cancellation and deadlines, then discover work outside the active boundary", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  const reader = new HistoryReader(store.readLocation());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false;
  const client: HistoryQueryClient = {
    async query<Q extends HistoryQuery>(query: Q, queryOptions: HistoryQueryOptions): Promise<HistoryResult<Q>> {
      const result = await reader.query(query, queryOptions);
      if (query.kind === "projection_batch" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
    cancelRun: id => reader.cancelRun(id),
    close: () => reader.close(),
  };
  const pending: Promise<void>[] = [];
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    finishHistoryExecution(store, historyExecution(store, run, skill));
    const learning = new ImprovementLearning(store, client);
    const active = learning.prepareFeedback(run.run_id, options());
    pending.push(active);
    await entered.promise;
    const late = historyExecution(store, run, skill);
    finishHistoryExecution(store, late);
    const cancelled = new AbortController();
    const waiting = learning.prepareFeedback(run.run_id, { ...options(), signal: cancelled.signal });
    const expired = learning.prepareFeedback(run.run_id, { deadlineHostMs: performance.now() + 20 });
    pending.push(waiting, expired);
    const cancellation = waiting.then(() => null, error => error);
    const expiration = expired.then(() => null, error => error);
    cancelled.abort();
    expect(await cancellation).toMatchObject({ code: "history_cancelled" });
    expect(await expiration).toMatchObject({ code: "history_deadline" });
    expect(store.opportunityCount(run.run_id)).toBe(0);
    const next = learning.prepareFeedback(run.run_id, options());
    pending.push(next);
    release.resolve();
    await active;
    await next;
    expect(store.opportunityCount(run.run_id)).toBe(2);
    expect(store.latestOpportunityForVersion({ run_id: run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash })?.execution_id).toBe(late.execution_id);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    try { await reader.close(); } finally { fixture.close(); }
  }
});

test("preparation queue overflow cannot cancel the active caller and cancelled waiters free their bounded capacity", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  const reader = new HistoryReader(store.readLocation());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let held = false;
  const client: HistoryQueryClient = {
    async query<Q extends HistoryQuery>(query: Q, queryOptions: HistoryQueryOptions): Promise<HistoryResult<Q>> {
      const result = await reader.query(query, queryOptions);
      if (query.kind === "projection_batch" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
    cancelRun: id => reader.cancelRun(id),
    close: () => reader.close(),
  };
  const pending: Promise<void>[] = [];
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    finishHistoryExecution(store, historyExecution(store, run, skill));
    const learning = new ImprovementLearning(store, client);
    const active = learning.prepareFeedback(run.run_id, options());
    pending.push(active);
    await entered.promise;
    const waiters = Array.from({ length: 8 }, () =>
      learning.prepareFeedback(run.run_id, { ...options(), signal: controller.signal }));
    pending.push(...waiters);
    const rejected = waiters.map(waiter => waiter.then(() => null, error => error));
    await expect(learning.prepareFeedback(run.run_id, options())).rejects.toMatchObject({ code: "history_queue_full" });
    controller.abort();
    for (const error of await Promise.all(rejected))
      expect(error).toMatchObject({ code: "history_cancelled" });
    const replacement = learning.prepareFeedback(run.run_id, options());
    pending.push(replacement);
    release.resolve();
    await Promise.all([active, replacement]);
    expect(store.opportunityCount(run.run_id)).toBe(1);
  } finally {
    controller.abort();
    release.resolve();
    await Promise.allSettled(pending);
    try { await reader.close(); } finally { fixture.close(); }
  }
});

test("a cancelled active preparation releases the next caller without advancing its checkpoint", async () => {
  const fixture = historyFixture(), { store, run } = fixture;
  const reader = new HistoryReader(store.readLocation());
  const controller = new AbortController();
  let cancelled = false;
  const client = interceptReader(reader, () => {
    if (!cancelled) { cancelled = true; controller.abort(); }
  });
  const pending: Promise<void>[] = [];
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const execution = historyExecution(store, run, skill);
    finishHistoryExecution(store, execution);
    const learning = new ImprovementLearning(store, client);
    const active = learning.prepareFeedback(run.run_id, { ...options(), signal: controller.signal });
    const next = learning.prepareFeedback(run.run_id, options());
    pending.push(active, next);
    await expect(active).rejects.toMatchObject({ code: "history_cancelled" });
    await next;
    expect(store.opportunityCount(run.run_id)).toBe(1);
    expect(store.latestOpportunityForVersion({ run_id: run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash })?.execution_id).toBe(execution.execution_id);
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    try { await reader.close(); } finally { fixture.close(); }
  }
});
