import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ActionView, ActivityEvent, GameAction, Json, PolicyView } from "../shared/contracts.ts";
import type { ImprovementOpportunity, ProgramVersionEvidence, ReadonlyDeathEpisode, TracePage, TraceRecord, WorkingProgram } from "../shared/execution-evidence.ts";
import { SKILL_API_VERSION, type SkillExecutionView, type SkillRef, type SkillView } from "../shared/programs.ts";
import type { StoredAction, StoredRun } from "./store.ts";
import { StoreDatabase, STORE_OPPORTUNITY_INDEXES, STORE_SCHEMA_VERSION } from "./store-database.ts";
import { requireProjectionBinding } from "./projection-storage.ts";
import {
  HISTORY_SOURCE_INDEXES, HISTORY_SOURCE_KINDS, HISTORY_SOURCE_TRIGGERS,
  type HistorySourceChanges, type HistorySourceKind, type HistorySourcePage, type HistorySourceRecord,
} from "./history-source.ts";
import { HistorySourceReadQueries, type HistorySourceReadDatabase as ReadDatabase } from "./history-source-read.ts";
import { HistorySnapshotStore, type HistoryDecodedSource } from "./history-snapshot.ts";
import { assertProjectionCheckpoint, HISTORY_PROJECTION_SCHEMA_SQL, PROJECTION_COLLECTIONS, type ProjectionCheckpoint, type ProjectionCollection, type ProjectionGeneration, type ProjectionQuery, type ProjectionRow } from "./history-projection.ts";

export interface StoreReadLocation {
  database: string;
  artifacts: string;
  /** Required for separated current stores; omitted only for frozen combined v7 stores. */
  projection?: string;
}

interface EventRow {
  event_seq: number;
  run_id: string | null;
  at: string;
  type: string;
  summary: string;
  details: string;
}
interface ActionRow {
  request: string;
  fingerprint: string;
  view: string;
}
interface TraceBudgetRow {
  recorded: number;
  bytes: number;
  omitted_records: number;
  omitted_bytes: number;
}
export interface PolicyRow {
  policy_id: string;
  run_id: string;
  version: number;
  name: string;
  hash: string;
  metadata: string;
}
export interface SkillRow {
  skill_id: string;
  run_id: string;
  version: number;
  name: string;
  hash: string;
  metadata: string;
}

const OPPORTUNITY_VERSION_KEYS = [
  "run_id",
  "json_extract(payload,'$.version.run_id')",
  "json_extract(payload,'$.version.skill_id')",
  "json_extract(payload,'$.version.version')",
  "json_extract(payload,'$.version.hash')",
];
const OPPORTUNITY_FAMILY_KEYS = ["run_id", "json_extract(payload,'$.version.skill_id')"];

function opportunityLookupSql(keys: readonly string[], index?: string, publishedOnly = false): string {
  const visibility = publishedOnly ? " AND NOT EXISTS(SELECT 1 FROM history_opportunity_visibility v WHERE v.run_id=evidence_objects.run_id AND v.opportunity_id=evidence_objects.object_key AND v.generation>COALESCE((SELECT json_extract(c.payload,'$.generation') FROM history_projection_checkpoints c WHERE c.run_id=evidence_objects.run_id),0))" : "";
  return `SELECT payload FROM evidence_objects${index ? ` INDEXED BY ${index}` : ""} WHERE kind='opportunity' AND ${keys.map(key => `${key}=?`).join(" AND ")}${visibility} ORDER BY rowid DESC LIMIT 1`;
}

const LATEST_OPPORTUNITY_VERSION_SQL = opportunityLookupSql(OPPORTUNITY_VERSION_KEYS, undefined, true);
const LATEST_OPPORTUNITY_FAMILY_SQL = opportunityLookupSql(OPPORTUNITY_FAMILY_KEYS, undefined, true);


export class StoreReadQueries {
  readonly #readDb: ReadDatabase;
  #projectionDb: ReadDatabase;
  readonly #readArtifactDir: string;
  readonly #historySources: HistorySourceReadQueries;

  protected constructor(readDb: ReadDatabase, readArtifactDir: string, projectionDb: ReadDatabase = readDb) {
    this.#readDb = readDb;
    this.#projectionDb = projectionDb;
    this.#readArtifactDir = readArtifactDir;
    this.#historySources = new HistorySourceReadQueries(readDb);
  }

  protected useProjectionDatabase(database: ReadDatabase): void { this.#projectionDb = database; }

  /** Internal source generation; unrelated to public feedback and event cursors. */
  historySourceHighwater(runId: string): number {
    return this.#historySources.highwater(runId);
  }

  historyProjectionRunPage(after: string | null, limit = 128): { run_ids: string[]; next_after: string | null; has_more: boolean } {
    if ((after !== null && typeof after !== "string") || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid history run page");
    const rows = this.#readDb.query<{ run_id: string }, [string | null, number]>(
      "SELECT run_id FROM runs WHERE (?1 IS NULL OR run_id>?1 COLLATE BINARY) ORDER BY run_id COLLATE BINARY LIMIT ?2",
    ).all(after, limit + 1);
    const run_ids = rows.slice(0, limit).map(row => row.run_id);
    return { run_ids, next_after: run_ids.at(-1) ?? after, has_more: rows.length > limit };
  }

  skillExecutionByOrdinal(runId: string, ordinal: number): SkillExecutionView | null {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("Invalid execution admission ordinal");
    const row = this.#readDb.query<{ view: string }, [number, string]>(
      "SELECT view FROM skill_executions INDEXED BY skill_executions_ordinal WHERE admission_ordinal=? AND run_id=?",
    ).get(ordinal, runId);
    return row ? this.readExecutionView(row.view) : null;
  }

  historyProjectionCheckpoint(runId: string): ProjectionCheckpoint | null {
    const row = this.#projectionDb.query<{ payload: string }, [string]>("SELECT payload FROM history_projection_checkpoints WHERE run_id=?").get(runId);
    if (!row) return null;
    const checkpoint = JSON.parse(row.payload) as ProjectionCheckpoint;
    assertProjectionCheckpoint(checkpoint);
    return checkpoint;
  }

  historyProjectionGeneration(runId: string, generation?: number): ProjectionGeneration | null {
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) throw new Error("Invalid history generation");
    return this.#projectionDb.transaction(() => {
      const checkpoint = this.historyProjectionCheckpoint(runId);
      if (!checkpoint) return null;
      const row = this.#projectionDb.query<{ generation: number; revision: number; source_through: number; metric_change_seq: number }, [string, number]>(
        "SELECT generation,revision,source_through,metric_change_seq FROM history_projection_generations WHERE run_id=? AND generation=?",
      ).get(runId, generation ?? checkpoint.generation);
      if (!row) return null;
      const source_available = this.historySourceHighwater(runId);
      if (row.source_through > source_available) throw new Error("Projection generation exceeds its bound source ledger");
      return { ...row, source_available, has_pending: checkpoint.phase !== "idle" || row.source_through < source_available,
        opportunity_change_seq: this.historyOpportunityVisibleThrough(runId, checkpoint.generation) };
    }).deferred();
  }

  private historyProjectionSelection(runId: string, revision: number, query: ProjectionQuery): { where: string; bindings: (string | number | null)[] } {
    if (!Number.isSafeInteger(revision) || revision < 0 || !PROJECTION_COLLECTIONS.includes(query.collection)) throw new Error("Invalid projection scope");
    const clauses = ["r.run_id=?", "r.collection=?", "r.revision<=?", "r.deleted=0",
      "NOT EXISTS(SELECT 1 FROM history_projection_rows newer WHERE newer.run_id=r.run_id AND newer.collection=r.collection AND newer.object_key=r.object_key AND newer.revision>r.revision AND newer.revision<=?)"];
    const bindings: (string | number | null)[] = [runId, query.collection, revision, revision];
    for (const key of ["owner_id", "source_id", "tag"] as const) if (query[key] !== undefined) { clauses.push(`r.${key} IS ?`); bindings.push(query[key]!); }
    for (const [key, column, operator] of [["before_order", "order_seq", "<"], ["after_order", "order_seq", ">"], ["before_tag", "tag", "<"], ["after_tag", "tag", ">"]] as const) {
      const value = query[key];
      if (value === undefined) continue;
      if ((key === "before_order" || key === "after_order") && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new Error("Invalid projection order bound");
      clauses.push(`r.${column}${operator}?`); bindings.push(value);
    }
    if (query.after) {
      if (!Number.isSafeInteger(query.after.order_seq) || query.after.order_seq < 0 || typeof query.after.key !== "string") throw new Error("Invalid projection cursor");
      const op = query.descending ? "<" : ">";
      clauses.push(`(r.order_seq${op}? OR (r.order_seq=? AND r.object_key${op}? COLLATE BINARY))`);
      bindings.push(query.after.order_seq, query.after.order_seq, query.after.key);
    }
    return { where: clauses.join(" AND "), bindings };
  }

  historyProjectionRow(runId: string, revision: number, collection: ProjectionCollection, key: string): ProjectionRow | null {
    if (!Number.isSafeInteger(revision) || revision < 0 || !PROJECTION_COLLECTIONS.includes(collection) || typeof key !== "string") throw new Error("Invalid projection exact key");
    const row = this.#projectionDb.query<{ collection: ProjectionCollection; object_key: string; owner_id: string | null; source_id: string | null; order_seq: number; tag: string | null; payload: string | null; deleted: number }, [string, string, string, number]>(
      "SELECT collection,object_key,owner_id,source_id,order_seq,tag,payload,deleted FROM history_projection_rows WHERE run_id=? AND collection=? AND object_key=? AND revision<=? ORDER BY revision DESC LIMIT 1",
    ).get(runId, collection, key, revision);
    if (!row || row.deleted) return null;
    return { collection: row.collection, key: row.object_key, owner_id: row.owner_id, source_id: row.source_id, order_seq: row.order_seq, tag: row.tag, value: JSON.parse(row.payload!) as Json };
  }

  historyProjectionRows(runId: string, revision: number, query: ProjectionQuery): ProjectionRow[] {
    const limit = query.limit ?? 128, offset = query.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid projection page bounds");
    const { where, bindings } = this.historyProjectionSelection(runId, revision, query);
    const direction = query.descending ? "DESC" : "ASC";
    const rows = this.#projectionDb.query<{ collection: ProjectionCollection; object_key: string; owner_id: string | null; source_id: string | null; order_seq: number; tag: string | null; payload: string }>(
      `SELECT r.collection,r.object_key,r.owner_id,r.source_id,r.order_seq,r.tag,r.payload FROM history_projection_rows r WHERE ${where} ORDER BY r.order_seq ${direction},r.object_key COLLATE BINARY ${direction} LIMIT ? OFFSET ?`,
    ).all(...bindings, limit, offset);
    return rows.map(row => ({ collection: row.collection, key: row.object_key, owner_id: row.owner_id, source_id: row.source_id, order_seq: row.order_seq, tag: row.tag, value: JSON.parse(row.payload) as Json }));
  }

  historyProjectionCount(runId: string, revision: number, query: ProjectionQuery): number {
    const { where, bindings } = this.historyProjectionSelection(runId, revision, query);
    return this.#projectionDb.query<{ total: number }>(`SELECT COUNT(*) AS total FROM history_projection_rows r WHERE ${where}`).get(...bindings)!.total;
  }

  private historyOpportunityVisibleThrough(runId: string, generation: number): number {
    return this.#projectionDb.query<{ through: number }, [string, number]>(
      "SELECT COALESCE(MAX(change_seq),0) AS through FROM history_opportunity_updates WHERE run_id=?1 AND change_seq<COALESCE((SELECT MIN(change_seq) FROM history_opportunity_updates WHERE run_id=?1 AND generation>?2),9223372036854775807)",
    ).get(runId, generation)!.through;
  }

  historyOpportunityBootstrapPage(runId: string, after = 0, limit = 128): { seq: number; value: ImprovementOpportunity }[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid opportunity bootstrap page");
    return this.#projectionDb.query<{ seq: number; payload: string }, [string, number, number]>(
      "SELECT e.rowid AS seq,e.payload FROM evidence_objects e WHERE e.run_id=? AND e.kind='opportunity' AND e.rowid>? AND NOT EXISTS(SELECT 1 FROM history_opportunity_updates u WHERE u.run_id=e.run_id AND u.opportunity_id=e.object_key) ORDER BY e.rowid LIMIT ?",
    ).all(runId, after, limit).map(row => ({ seq: row.seq, value: JSON.parse(row.payload) as ImprovementOpportunity }));
  }

  opportunityUpdates(runId: string, after = 0, limit = 128, skillId?: string, version?: number): { records: { change_seq: number; value: ImprovementOpportunity }[]; next_after: number; through: number; has_more: boolean } {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid opportunity update page");
    return this.#projectionDb.transaction(() => {
      const generation = this.historyProjectionCheckpoint(runId)?.generation ?? 0;
      const through = this.historyOpportunityVisibleThrough(runId, generation);
      if (after > through) throw new Error("Opportunity cursor exceeds visible history");
      const scope = skillId === undefined ? "" : version === undefined ? " AND skill_id=?" : " AND skill_id=? AND version=?";
      const bindings: (string | number)[] = [runId, after, through];
      if (skillId !== undefined) { bindings.push(skillId); if (version !== undefined) bindings.push(version); }
      const rows = this.#projectionDb.query<{ change_seq: number; payload: string }>(
        `SELECT change_seq,payload FROM history_opportunity_updates WHERE run_id=? AND change_seq>? AND change_seq<=?${scope} ORDER BY change_seq LIMIT ?`,
      ).all(...bindings, limit + 1);
      const records = rows.slice(0, limit).map(row => ({ change_seq: row.change_seq, value: JSON.parse(row.payload) as ImprovementOpportunity }));
      return { records, next_after: rows.length > limit ? records.at(-1)!.change_seq : through, through, has_more: rows.length > limit };
    }).deferred();
  }

  historySourceChanges(runId: string, after: number, through?: number, limit = 128): HistorySourceChanges {
    return this.#historySources.changes(runId, after, through, limit);
  }

  historySourceRecord(runId: string, kind: HistorySourceKind, key: string, through: number): HistorySourceRecord | null {
    return this.#historySources.record(runId, kind, key, through);
  }

  historySourcePage(runId: string, kind: HistorySourceKind, through: number, after = 0, throughKey?: number, limit = 128): HistorySourcePage {
    return this.#historySources.page(runId, kind, through, after, throughKey, limit);
  }

  /** Canonical oracle adapter only; this is not an incremental production query. */
  historySnapshot(runId: string, through: number): HistorySnapshotStore {
    return new HistorySnapshotStore(this, runId, through);
  }

  decodeHistorySource<K extends HistorySourceKind>(kind: K, record: HistorySourceRecord): HistoryDecodedSource[K] {
    const row = record.columns;
    let decoded: HistoryDecodedSource[HistorySourceKind];
    switch (kind) {
      case "run":
        decoded = this.normalizeRun(row.payload as string);
        break;
      case "action":
        decoded = this.readStoredAction(row as unknown as ActionRow);
        break;
      case "execution":
        decoded = this.readExecutionView(row.view as string);
        break;
      case "event":
        decoded = this.readEventView(row as unknown as EventRow);
        break;
      case "trace":
        decoded = this.readTraceView(row as unknown as { trace_seq: number; payload: string });
        break;
      case "trace_budget":
        decoded = this.historyTraceBudget(row as unknown as TraceBudgetRow);
        break;
      case "skill":
        decoded = this.hydrateSkill(row as unknown as SkillRow);
        break;
      default:
        throw new Error("Invalid history source kind");
    }
    return decoded as HistoryDecodedSource[K];
  }

  /** Historical records retain null authority; decoding never upgrades them into active invocations. */
  protected readExecutionView(encoded: string): SkillExecutionView {
    return { entry: null, session_id: null, life_id: null, world_id: null, native_boot_id: null, run_generation: null,
      space_epoch: null, source_hash: null, compatibility_hash: null, ...JSON.parse(encoded) };
  }
  protected readActionView(encoded: string): ActionView {
    return { session_id: null, life_id: null, scope: null, invocation: null, compatibility_hash: null, ...JSON.parse(encoded) };
  }

  protected readStoredAction(row: ActionRow): StoredAction {
    return {
      request: JSON.parse(row.request) as GameAction,
      fingerprint: row.fingerprint,
      view: this.readActionView(row.view),
    };
  }

  protected readEventView(row: EventRow): ActivityEvent {
    return { ...row, details: JSON.parse(row.details) as Json };
  }

  protected readTraceView(row: { trace_seq: number; payload: string }): TraceRecord {
    return { ...JSON.parse(row.payload), trace_seq: row.trace_seq } as TraceRecord;
  }

  protected normalizeRun(payload: string): StoredRun {
    const run = JSON.parse(payload) as StoredRun & {
      action?: unknown;
      policies?: unknown;
      skills?: unknown;
      executions?: unknown;
    };
    delete run.action;
    delete run.policies;
    delete run.skills;
    delete run.executions;
    run.session_id ??= null;
    run.life_id ??= null;
    run.native_boot_id ??= null;
    run.space_epoch ??= null;
    run.compatibility_hash ??= null;
    const usage = run.usage as StoredRun["usage"] & {
      input_tokens?: number;
      output_tokens?: number;
    };
    if ("input_tokens" in usage || "output_tokens" in usage) {
      const unattributed = () => ({
        uncached_input: null,
        cache_read: null,
        cache_write: null,
        output: null,
        calls: null,
        known_cost: null,
        legacy_input: null,
      });
      run.usage = {
        uncached_input: null,
        cache_read: null,
        cache_write: null,
        output: usage.output_tokens ?? null,
        calls: null,
        known_cost: usage.known_cost ?? null,
        legacy_input: usage.input_tokens ?? null,
        accounting_basis: "sdk_reported_subtotal",
        by_purpose: {
          authoring: unattributed(),
          planning: unattributed(),
          replanning: unattributed(),
          improvement: unattributed(),
          other: unattributed(),
        },
      };
    }
    // Read-time qualification only: opening a Store must not rewrite historical usage.
    run.usage.accounting_basis = "sdk_reported_subtotal";
    return run;
  }

  events(runId: string | null = null, after = 0, limit = 100): ActivityEvent[] {
    const cap = Math.max(1, Math.min(500, limit));
    const rows = runId
      ? this.#readDb
          .query<EventRow, [string, number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE run_id=? AND event_seq>? ORDER BY event_seq DESC LIMIT ?",
          )
          .all(runId, after, cap)
      : this.#readDb
          .query<EventRow, [number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE event_seq>? ORDER BY event_seq DESC LIMIT ?",
          )
          .all(after, cap);
    return rows
      .reverse()
      .map((row) => this.readEventView(row));
  }

  latestEvent(runId: string, type: string): ActivityEvent | null {
    const row = this.#readDb.query<EventRow, [string, string]>(
      "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE run_id=? AND type=? ORDER BY event_seq DESC LIMIT 1",
    ).get(runId, type);
    return row ? this.readEventView(row) : null;
  }

  eventsAfter(
    runId: string | null,
    after: number,
    limit: number,
  ): ActivityEvent[] {
    const cap = Math.max(1, Math.min(500, limit));
    const rows = runId
      ? this.#readDb
          .query<EventRow, [string, number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE run_id=? AND event_seq>? ORDER BY event_seq ASC LIMIT ?",
          )
          .all(runId, after, cap)
      : this.#readDb
          .query<EventRow, [number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE event_seq>? ORDER BY event_seq ASC LIMIT ?",
          )
          .all(after, cap);
    return rows.map((row) => this.readEventView(row));
  }

  lastEventSeq(): number {
    return (
      this.#readDb
        .query<{ cursor: number }, []>(
          "SELECT COALESCE(MAX(event_seq),0) AS cursor FROM events",
        )
        .get()?.cursor ?? 0
    );
  }

  lastRun(): StoredRun | null {
    const row = this.#readDb
      .query<{ payload: string }, []>(
        "SELECT payload FROM runs ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    return row ? this.normalizeRun(row.payload) : null;
  }

  runs(limit = 50): StoredRun[] {
    const cap = Number.isFinite(limit)
      ? Math.max(1, Math.min(500, Math.floor(limit)))
      : 50;
    return this.#readDb
      .query<{ payload: string }, [number]>(
        "SELECT payload FROM runs ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(cap)
      .map((row) => this.normalizeRun(row.payload));
  }

  getRun(id: string): StoredRun | null {
    const row = this.#readDb
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runs WHERE run_id=?",
      )
      .get(id);
    return row ? this.normalizeRun(row.payload) : null;
  }

  getAction(runId: string, id: string): StoredAction | null {
    const row = this.#readDb
      .query<
        ActionRow,
        [string, string]
      >(
        "SELECT request,fingerprint,view FROM actions WHERE run_id=? AND action_id=?",
      )
      .get(runId, id);
    return row ? this.readStoredAction(row) : null;
  }

  selectedAction(runId: string, target: "current" | "latest", executionId?: string): ActionView | null {
    const row = this.#readDb.query<{ view: string }, [string, string, string | null, string | null, string | null]>(
      "SELECT a.view FROM actions a LEFT JOIN skill_executions e ON e.run_id=a.run_id AND e.execution_id=json_extract(a.view,'$.execution_id') WHERE a.run_id=? AND (?='latest' OR json_extract(a.view,'$.status') IN ('accepted','running','cancel_requested')) AND (? IS NULL OR e.execution_id=? OR e.root_execution_id=?) ORDER BY a.rowid DESC LIMIT 1",
    ).get(runId, target, executionId ?? null, executionId ?? null, executionId ?? null);
    return row ? this.readActionView(row.view) : null;
  }

  private readSource(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid stored artifact hash");
    const source = readFileSync(
      path.join(this.#readArtifactDir, `${hash}.js`),
    );
    if (createHash("sha256").update(source).digest("hex") !== hash)
      throw new Error("Stored artifact integrity check failed");
    return source.toString("utf8");
  }

  protected hydratePolicy(row: PolicyRow): PolicyView {
    return {
      ...(JSON.parse(row.metadata) as Omit<PolicyView, "source">),
      source: this.readSource(row.hash),
    };
  }

  policies(runId: string): PolicyView[] {
    return this.#readDb
      .query<PolicyRow, [string]>(
        "SELECT policy_id,run_id,version,name,hash,metadata FROM policies WHERE run_id=? ORDER BY name,version",
      )
      .all(runId)
      .map((row) => this.hydratePolicy(row));
  }

  protected hydrateSkill(row: SkillRow): SkillView {
    return {
      ...(JSON.parse(row.metadata) as Omit<SkillView, "source">),
      skill_id: row.skill_id,
      version: row.version,
      name: row.name,
      hash: row.hash,
      source: this.readSource(row.hash),
    };
  }

  skills(runId: string): SkillView[] {
    return this.#readDb
      .query<SkillRow, [string]>(
        "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? ORDER BY name,version",
      )
      .all(runId)
      .map((row) => this.hydrateSkill(row));
  }

  namedSkill(runId: string, name: string, version?: number, validated = false): SkillView | null {
    const row = this.#readDb.query<SkillRow, [string, string, number | null, number | null, number]>(
      "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? AND name=? AND (? IS NULL OR version=?) AND (?=0 OR json_extract(metadata,'$.state')='validated') ORDER BY version DESC LIMIT 1",
    ).get(runId, name, version ?? null, version ?? null, validated ? 1 : 0);
    return row ? this.hydrateSkill(row) : null;
  }

  programCatalog(runId: string, after: number, limit: number) {
    const rows = this.#readDb.query<SkillRow & { seq: number }, [string, string, number, number, number]>(
      "SELECT s.rowid AS seq,s.run_id,s.skill_id,s.version,s.name,s.hash,s.metadata FROM skills s JOIN (SELECT name,MAX(version) AS version FROM skills WHERE run_id=? GROUP BY name) latest ON s.name=latest.name AND s.version=latest.version WHERE s.run_id=? AND (?=0 OR s.rowid<?) ORDER BY s.rowid DESC LIMIT ?",
    ).all(runId, runId, after, after, limit + 1);
    const selected = rows.slice(0, limit);
    return { records: selected.map((row) => {
      const value = JSON.parse(row.metadata) as SkillView;
      return { name: row.name, version: row.version, entry: value.entry ?? null, purpose: value.card.purpose.slice(0, 200), state: value.state,
        execution_compatible: !!value.entry && value.validation.runtime_version === SKILL_API_VERSION &&
          value.validation.api_version === 5 && value.validation.validator_version === 5 &&
          value.validation.compatibility_hash === this.getRun(runId)?.compatibility_hash, created_at: value.created_at,
        ...(value.card.purpose.length > 200 ? { purpose_omission: { reason: "catalog_summary", original_characters: value.card.purpose.length } } : {}) };
    }), next_after: selected.at(-1)?.seq ?? after, has_more: rows.length > limit, omissions: [] };
  }

  skill(runId: string, ref: SkillRef): SkillView {
    const row = this.#readDb
      .query<SkillRow, [string, string, number]>(
        "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? AND skill_id=? AND version=?",
      )
      .get(runId, ref.skill_id, ref.version);
    if (!row) throw new Error("Skill version not found in this run");
    return this.hydrateSkill(row);
  }

  skillExecution(
    runId: string,
    lookup: { start_key: string } | { execution_id: string },
  ): SkillExecutionView | null {
    const row =
      "start_key" in lookup
        ? this.#readDb
            .query<{ view: string }, [string, string]>(
              "SELECT view FROM skill_executions WHERE run_id=? AND start_key=?",
            )
            .get(runId, lookup.start_key)
        : this.#readDb
            .query<{ view: string }, [string, string]>(
              "SELECT view FROM skill_executions WHERE run_id=? AND execution_id=?",
            )
            .get(runId, lookup.execution_id);
    return row ? this.readExecutionView(row.view) : null;
  }

  skillExecutions(runId: string): SkillExecutionView[] {
    return this.#readDb
      .query<{ view: string }, [string]>(
        "SELECT view FROM skill_executions WHERE run_id=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(runId)
      .map((row) => this.readExecutionView(row.view));
  }

  /** Durable root identity, independent of the bounded presentation snapshot. */
  latestRootExecution(runId: string): SkillExecutionView | null {
    const row = this.#readDb.query<{ view: string }, [string]>(
      "SELECT view FROM skill_executions WHERE run_id=? AND parent_execution_id IS NULL ORDER BY rowid DESC LIMIT 1",
    ).get(runId);
    return row ? this.readExecutionView(row.view) : null;
  }

  selectedSkillExecution(runId: string, target: "current" | "latest", skillId?: string, version?: number): SkillExecutionView | null {
    const row = this.#readDb.query<{ view: string }, [string, string | null, string | null, number | null, number | null, string]>(
      "SELECT view FROM skill_executions WHERE run_id=? AND ((? IS NULL AND parent_execution_id IS NULL) OR skill_id=?) AND (? IS NULL OR version=?) AND (?='latest' OR json_extract(view,'$.status') IN ('accepted','running','cancel_requested')) ORDER BY rowid DESC LIMIT 1",
    ).get(runId, skillId ?? null, skillId ?? null, version ?? null, version ?? null, target);
    return row ? this.readExecutionView(row.view) : null;
  }

  executionReferences(runId: string, executionId?: string) {
    return this.#readDb.query<{ execution_id: string; name: string; version: number; execution_ordinal: number }, [string, string | null, string | null]>(
      "SELECT e.execution_id,s.name,e.version,e.admission_ordinal AS execution_ordinal FROM skill_executions e JOIN skills s ON s.run_id=e.run_id AND s.skill_id=e.skill_id AND s.version=e.version WHERE e.run_id=? AND (? IS NULL OR e.execution_id=?) ORDER BY e.admission_ordinal",
    ).all(runId, executionId ?? null, executionId ?? null);
  }

  /** Complete ledger traversal; the UI snapshot's latest-100 cap is not evidence scope. */
  allSkillExecutions(runId: string): SkillExecutionView[] {
    return this.#readDb.query<{ view: string }, [string]>(
      "SELECT view FROM skill_executions WHERE run_id=? ORDER BY rowid",
    ).all(runId).map(({ view }) => this.readExecutionView(view));
  }

  /** Logical archive order, with count and bounded row hydration in one read snapshot. */
  collectionRowsPage(
    runId: string,
    collection: "sources" | "policies" | "executions" | "events" | "traces",
    recordIndex: number,
    limit: number,
  ): { records: (SkillView | PolicyView | SkillExecutionView | ActivityEvent | TraceRecord)[]; total: number } {
    if (!Number.isSafeInteger(recordIndex) || recordIndex < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid collection row cursor or limit");
    return this.#readDb.transaction(() => {
      switch (collection) {
        case "sources": {
          const total = this.#readDb.query<{ total: number }, [string]>(
            "SELECT COUNT(*) AS total FROM skills WHERE run_id=?",
          ).get(runId)!.total;
          const rows = this.#readDb.query<SkillRow, [string, number, number]>(
            "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? ORDER BY name,version LIMIT ? OFFSET ?",
          ).all(runId, limit, recordIndex);
          return { total, records: rows.map(row => this.hydrateSkill(row)) };
        }
        case "policies": {
          const total = this.#readDb.query<{ total: number }, [string]>(
            "SELECT COUNT(*) AS total FROM policies WHERE run_id=?",
          ).get(runId)!.total;
          const rows = this.#readDb.query<PolicyRow, [string, number, number]>(
            "SELECT policy_id,run_id,version,name,hash,metadata FROM policies WHERE run_id=? ORDER BY name,version LIMIT ? OFFSET ?",
          ).all(runId, limit, recordIndex);
          return { total, records: rows.map(row => this.hydratePolicy(row)) };
        }
        case "executions": {
          const total = this.#readDb.query<{ total: number }, [string]>(
            "SELECT COUNT(*) AS total FROM skill_executions WHERE run_id=?",
          ).get(runId)!.total;
          const rows = this.#readDb.query<{ view: string }, [string, number, number]>(
            "SELECT view FROM skill_executions WHERE run_id=? ORDER BY rowid LIMIT ? OFFSET ?",
          ).all(runId, limit, recordIndex);
          return { total, records: rows.map(row => this.readExecutionView(row.view)) };
        }
        case "events": {
          const total = this.#readDb.query<{ total: number }, [string]>(
            "SELECT COUNT(*) AS total FROM events WHERE run_id=?",
          ).get(runId)!.total;
          const rows = this.#readDb.query<EventRow, [string, number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE run_id=? ORDER BY event_seq LIMIT ? OFFSET ?",
          ).all(runId, limit, recordIndex);
          return { total, records: rows.map(row => this.readEventView(row)) };
        }
        case "traces": {
          const total = this.#readDb.query<{ total: number }, [string]>(
            "SELECT COUNT(*) AS total FROM execution_trace WHERE run_id=?",
          ).get(runId)!.total;
          const rows = this.#readDb.query<{ trace_seq: number; payload: string }, [string, number, number]>(
            "SELECT trace_seq,payload FROM execution_trace WHERE run_id=? ORDER BY trace_seq LIMIT ? OFFSET ?",
          ).all(runId, limit, recordIndex);
          return { total, records: rows.map(row => this.readTraceView(row)) };
        }
      }
    }).deferred();
  }

  protected traceBudget(runId: string): TracePage["budget"] {
    const row = this.#readDb.query<TraceBudgetRow, [string]>(
      "SELECT recorded,bytes,omitted_records,omitted_bytes FROM trace_budgets WHERE run_id=?",
    ).get(runId);
    return this.historyTraceBudget(row);
  }

  historyTraceBudget(row: TraceBudgetRow | null): TracePage["budget"] {
    return { max_records: 8192, max_bytes: 8 * 1024 * 1024, recorded: 0, bytes: 0, omitted_records: 0, omitted_bytes: 0,
      ...(row ? { recorded: row.recorded, bytes: row.bytes, omitted_records: row.omitted_records, omitted_bytes: row.omitted_bytes } : {}) };
  }

  tracePage(runId: string, after = 0, limit = 100, executionId?: string): TracePage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid trace cursor or limit");
    const rows = executionId
      ? this.#readDb.query<{ trace_seq: number; payload: string }, [string, number, string, string, number]>(
        "SELECT trace_seq,payload FROM execution_trace WHERE run_id=? AND trace_seq>? AND (json_extract(payload,'$.execution_id')=? OR json_extract(payload,'$.root_execution_id')=?) ORDER BY trace_seq LIMIT ?",
      ).all(runId, after, executionId, executionId, Math.min(limit, 500) + 1)
      : this.#readDb.query<{ trace_seq: number; payload: string }, [string, number, number]>(
        "SELECT trace_seq,payload FROM execution_trace WHERE run_id=? AND trace_seq>? ORDER BY trace_seq LIMIT ?",
      ).all(runId, after, Math.min(limit, 500) + 1);
    return this.packHistoryTracePage(rows, this.traceBudget(runId), after, limit);
  }

  /** Shared pure packing keeps historical and current trace envelopes identical. */
  packHistoryTracePage(rows: readonly { trace_seq: number; payload: string }[], budget: TracePage["budget"], after: number, limit: number): TracePage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid trace cursor or limit");
    const page: TracePage = { records: [], next_after: after, has_more: false, budget };
    for (const row of rows) {
      const record = this.readTraceView(row);
      const candidate = { ...page, records: [...page.records, record], next_after: record.trace_seq, has_more: false };
      if (page.records.length >= Math.min(limit, 500) || Buffer.byteLength(JSON.stringify(candidate)) > 65536) {
        page.has_more = true;
        break;
      }
      page.records.push(record);
      page.next_after = record.trace_seq;
    }
    return page;
  }

  traceRecord(runId: string, sequence: number): TraceRecord | null {
    const row = this.#readDb.query<{ payload: string }, [string, number]>(
      "SELECT payload FROM execution_trace WHERE run_id=? AND trace_seq=?",
    ).get(runId, sequence);
    return row ? this.readTraceView({ ...row, trace_seq: sequence }) : null;
  }

  evidenceObjects<T>(runId: string, kind: "death" | "opportunity"): T[] {
    return (kind === "opportunity" ? this.#projectionDb : this.#readDb).query<{ payload: string }, [string, string]>(
      "SELECT payload FROM evidence_objects WHERE run_id=? AND kind=? ORDER BY rowid",
    ).all(runId, kind).map(({ payload }) => JSON.parse(payload) as T);
  }

  evidenceObjectRows<T>(runId: string, kind: "opportunity", after: number, limit: number): { seq: number; value: T }[] {
    return this.#projectionDb.query<{ seq: number; payload: string }, [string, string, number, number]>(
      "SELECT rowid AS seq,payload FROM evidence_objects WHERE run_id=? AND kind=? AND rowid>? ORDER BY rowid LIMIT ?",
    ).all(runId, kind, after, limit).map((row) => ({ seq: row.seq, value: JSON.parse(row.payload) as T }));
  }

  skillExecutionRows(runId: string, after: number, limit: number): { seq: number; value: SkillExecutionView }[] {
    return this.#readDb.query<{ seq: number; view: string }, [string, number, number]>(
      "SELECT rowid AS seq,view FROM skill_executions WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT ?",
    ).all(runId, after, limit).map((row) => ({ seq: row.seq, value: this.readExecutionView(row.view) }));
  }

  deathEpisodesPage(runId: string, after = 0, limit = 32) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid death episode cursor or limit");
    const all = this.evidenceObjects<ReadonlyDeathEpisode>(runId, "death");
    const page = { episodes: [] as ReadonlyDeathEpisode[], next_after: after, has_more: false };
    for (const episode of all.slice(after, after + Math.min(limit, 100))) {
      const candidate = { episodes: [...page.episodes, episode], next_after: page.next_after + 1, has_more: false };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 65536) break;
      page.episodes.push(episode);
      page.next_after++;
    }
    page.has_more = page.next_after < all.length;
    return page;
  }

  workingPrograms(modelId: string, sessionId: string): WorkingProgram[] {
    return this.#readDb.query<{ payload: string }, [string, string, string, string]>(
      "SELECT payload FROM working_programs WHERE model_id=? AND session_id=? AND json_extract(payload,'$.source_run_id')=(SELECT json_extract(payload,'$.source_run_id') FROM working_programs WHERE model_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY rowid",
    ).all(modelId, sessionId, modelId, sessionId).map(({ payload }) => JSON.parse(payload) as WorkingProgram);
  }

  opportunity(runId: string, id: string): ImprovementOpportunity | null {
    const row = this.#projectionDb.query<{ payload: string }, [string, string]>(
      "SELECT payload FROM evidence_objects WHERE run_id=? AND kind='opportunity' AND object_key=?",
    ).get(runId, id);
    return row ? JSON.parse(row.payload) as ImprovementOpportunity : null;
  }

  latestOpportunityForVersion(ref: ProgramVersionEvidence): ImprovementOpportunity | null {
    const row = this.#projectionDb.query<{ payload: string }, [string, string, string, number, string]>(
      LATEST_OPPORTUNITY_VERSION_SQL,
    ).get(ref.run_id, ref.run_id, ref.skill_id, ref.version, ref.hash);
    return row ? JSON.parse(row.payload) as ImprovementOpportunity : null;
  }

  latestOpportunityForFamily(runId: string, skillId: string): ImprovementOpportunity | null {
    const row = this.#projectionDb.query<{ payload: string }, [string, string]>(
      LATEST_OPPORTUNITY_FAMILY_SQL,
    ).get(runId, skillId);
    return row ? JSON.parse(row.payload) as ImprovementOpportunity : null;
  }

  opportunityCount(runId: string): number {
    return this.#projectionDb.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM evidence_objects WHERE run_id=? AND kind='opportunity'",
    ).get(runId)!.count;
  }

}

/** Open only a writer-prepared, already-existing database. Never create or repair it. */
export class ReadonlyStore extends StoreReadQueries {
  readonly #database: StoreDatabase;
  readonly #projection: StoreDatabase;
  #closed = false;

  constructor(location: StoreReadLocation) {
    const connection = new Database(location.database, { readonly: true, create: false, strict: true });
    const database = new StoreDatabase(connection);
    super(database, location.artifacts);
    this.#database = database;
    let projection: StoreDatabase = database;
    try {
      if (location.projection) projection = new StoreDatabase(new Database(location.projection, { readonly: true, create: false, strict: true }));
      this.#projection = projection;
      this.useProjectionDatabase(projection);
      if (location.projection) requireProjectionBinding(database, projection);
      this.snapshot(() => this.requireReadySchema());
    } catch (error) {
      if (projection !== database) projection.close();
      database.close();
      throw error;
    }
  }

  private requireReadySchema(): void {
    const version = this.#database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    if (version !== (this.#projection === this.#database ? 7 : STORE_SCHEMA_VERSION))
      throw new Error(`Readonly store requires the current writer-migrated schema (user_version ${STORE_SCHEMA_VERSION})`);
    const databaseFor = (table: string): StoreDatabase =>
      table === "evidence_objects" || table.startsWith("history_projection_") || table.startsWith("history_opportunity_") ? this.#projection : this.#database;
    const tables = {
      runs: ["run_id", "created_at", "payload"],
      events: ["event_seq", "run_id", "at", "type", "summary", "details"],
      actions: ["run_id", "action_id", "fingerprint", "request", "view"],
      policies: ["policy_id", "run_id", "version", "name", "hash", "metadata"],
      skills: ["run_id", "skill_id", "version", "name", "hash", "metadata"],
      skill_executions: ["run_id", "execution_id", "admission_ordinal", "start_key", "skill_id", "version", "parent_execution_id", "root_execution_id", "fingerprint", "request", "view"],
      store_metadata: ["key", "value"],
      execution_trace: ["trace_seq", "run_id", "payload", "bytes"],
      trace_budgets: ["run_id", "recorded", "bytes", "omitted_records", "omitted_bytes"],
      evidence_objects: ["run_id", "kind", "object_key", "payload"],
      working_programs: ["session_id", "model_id", "skill_id", "version", "payload"],
      history_projection_rows: ["run_id", "collection", "object_key", "revision", "owner_id", "source_id", "order_seq", "tag", "payload", "deleted"],
      history_projection_checkpoints: ["run_id", "payload"],
      history_projection_generations: ["run_id", "generation", "revision", "source_through", "metric_change_seq"],
      history_opportunity_visibility: ["run_id", "opportunity_id", "generation"],
      history_opportunity_updates: ["change_seq", "run_id", "opportunity_id", "generation", "skill_id", "version", "payload"],
      history_source_changes: ["change_seq", "run_id", "kind", "source_key"],
      history_source_versions: ["run_id", "kind", "source_key", "change_seq", "ordinal", "present", "payload"],
      history_source_keys: ["key_seq", "run_id", "kind", "source_key", "created_seq"],
      history_source_bootstrap: ["kind", "through_ordinal", "after_ordinal"],
    };
    const integerColumns = new Set(["event_seq", "version", "admission_ordinal", "value", "trace_seq", "bytes", "recorded", "omitted_records", "omitted_bytes",
      "revision",
      "change_seq", "ordinal", "present", "key_seq", "created_seq", "through_ordinal", "after_ordinal", "order_seq", "deleted", "generation", "source_through", "metric_change_seq"]);
    const tableIndexes = new Map<string, { name: string; unique: number; partial: number }[]>();
    for (const [table, required] of Object.entries(tables)) {
      const columns = databaseFor(table).query<{ name: string; type: string }, []>(`PRAGMA table_info(${table})`).all();
      if (required.some((name) => !columns.some((column) =>
        column.name === name && column.type.toUpperCase() === (integerColumns.has(name) ? "INTEGER" : "TEXT"))))
        throw new Error(`Readonly store requires writer-prepared table ${table}`);
      tableIndexes.set(table, databaseFor(table).query<{ name: string; unique: number; partial: number }, []>(
        `PRAGMA index_list(${table})`,
      ).all());
    }
    const indexes = [
      { name: "events_run_seq", table: "events", columns: ["run_id", "event_seq"] },
      { name: "events_run_type_seq", table: "events", columns: ["run_id", "type", "event_seq"] },
      { name: "policies_run", table: "policies", columns: ["run_id", "name", "version"] },
      { name: "skills_run", table: "skills", columns: ["run_id", "name", "version"] },
      { name: "skills_ref", table: "skills", columns: ["skill_id", "version"] },
      { name: "skill_executions_parent", table: "skill_executions", columns: ["run_id", "parent_execution_id"] },
      { name: "skill_executions_root", table: "skill_executions", columns: ["run_id", "root_execution_id"] },
      { name: "skill_executions_ordinal", table: "skill_executions", columns: ["admission_ordinal"], unique: true },
      { name: "trace_run_seq", table: "execution_trace", columns: ["run_id", "trace_seq"] },
      { name: "history_projection_order", table: "history_projection_rows", columns: ["run_id", "collection", "order_seq", "object_key", "revision"] },
      { name: "history_projection_owner", table: "history_projection_rows", columns: ["run_id", "collection", "owner_id", "order_seq", "object_key", "revision"] },
      { name: "history_projection_source", table: "history_projection_rows", columns: ["run_id", "collection", "source_id", "order_seq", "object_key", "revision"] },
      { name: "history_projection_tag", table: "history_projection_rows", columns: ["run_id", "collection", "tag", "order_seq", "object_key", "revision"] },
      { name: "history_opportunity_updates_run", table: "history_opportunity_updates", columns: ["run_id", "change_seq"] },
      { name: "history_opportunity_updates_scope", table: "history_opportunity_updates", columns: ["run_id", "skill_id", "version", "change_seq"] },
      ...STORE_OPPORTUNITY_INDEXES.map(({ name }) => ({
        name, table: "evidence_objects", columns: null, partial: true,
      })),
    ];
    for (const index of indexes) {
      const row = tableIndexes.get(index.table)?.find((entry) => entry.name === index.name);
      if (!row || row.unique !== ("unique" in index && index.unique ? 1 : 0) ||
        row.partial !== ("partial" in index && index.partial ? 1 : 0))
        throw new Error(`Readonly store requires writer-prepared index ${index.name}`);
      if (index.columns) {
        const columns = databaseFor(index.table).query<{ name: string | null }, []>(`PRAGMA index_info(${index.name})`).all();
        if (columns.length !== index.columns.length || columns.some((column, position) => column.name !== index.columns![position]))
          throw new Error(`Readonly store requires writer-prepared index columns ${index.name}`);
      }
    }
    // Source snapshots and opportunity visibility require real journal triggers.
    // Checking names alone would silently accept no-op triggers or incomplete keys.
    const normalizeDdl = (sql: string): string => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
    for (const definition of [...HISTORY_SOURCE_INDEXES, ...HISTORY_SOURCE_TRIGGERS]) {
      const row = this.#database.query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_schema WHERE name=? AND type IN ('index','trigger')",
      ).get(definition.name);
      if (!row?.sql || normalizeDdl(row.sql) !== normalizeDdl(definition.sql))
        throw new Error(`Readonly store requires writer-prepared journal behavior ${definition.name}`);
    }
    for (const expected of HISTORY_PROJECTION_SCHEMA_SQL.match(/CREATE TRIGGER IF NOT EXISTS history_opportunity_(?:insert|update)[\s\S]*?END;/g) ?? []) {
      const name = /CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(expected)![1]!;
      const actual = this.#projection.query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
      if (!actual?.sql || normalizeDdl(actual.sql) !== normalizeDdl(expected)) throw new Error(`Readonly store requires writer-prepared opportunity journal behavior ${name}`);
    }
    for (const [table, primaryKey] of [
      ["history_source_changes", ["change_seq"]],
      ["history_source_versions", ["run_id", "kind", "source_key", "change_seq"]],
      ["history_source_keys", ["key_seq"]],
      ["history_source_bootstrap", ["kind"]],
      ["history_projection_rows", ["run_id", "collection", "object_key", "revision"]],
      ["history_projection_checkpoints", ["run_id"]],
      ["history_projection_generations", ["run_id", "generation"]],
      ["history_opportunity_visibility", ["run_id", "opportunity_id"]],
      ["history_opportunity_updates", ["change_seq"]],
    ] as const) {
      const actual = databaseFor(table).query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`).all()
        .filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk);
      if (actual.length !== primaryKey.length || actual.some((column, position) => column.name !== primaryKey[position]))
        throw new Error(`Readonly store requires writer-prepared source primary key ${table}`);
    }
    const keyIdentity = ["run_id", "kind", "source_key"];
    const uniqueKeys = tableIndexes.get("history_source_keys")!.filter(index => index.unique === 1 && index.partial === 0);
    if (!uniqueKeys.some(index => {
      // This identifier came from SQLite, not from a source cursor.
      const escapedName = index.name.replace(/"/g, '""');
      const columns = this.#database.query<{ name: string | null }, []>(`PRAGMA index_info("${escapedName}")`).all();
      return columns.length === keyIdentity.length && columns.every((column, position) => column.name === keyIdentity[position]);
    })) throw new Error("Readonly store requires writer-prepared unique source key identities");
    const bootstrap = this.#database.query<{ kind: string; through_ordinal: number; after_ordinal: number }, []>(
      "SELECT kind,through_ordinal,after_ordinal FROM history_source_bootstrap",
    ).all();
    if (bootstrap.length !== HISTORY_SOURCE_KINDS.length || HISTORY_SOURCE_KINDS.some(kind => !bootstrap.some(row => row.kind === kind)) ||
      bootstrap.some(row => !Number.isSafeInteger(row.through_ordinal) || !Number.isSafeInteger(row.after_ordinal) ||
        row.after_ordinal < 0 || row.through_ordinal < row.after_ordinal))
      throw new Error("Readonly store requires writer-prepared source bootstrap cursors");
    // Ask SQLite about the production lookup, not the spelling of historical DDL.
    // INDEXED BY also rejects partial predicates that cannot serve opportunity reads.
    for (const { name, keys } of [
      { name: "evidence_opportunity_version", keys: OPPORTUNITY_VERSION_KEYS },
      { name: "evidence_opportunity_family", keys: OPPORTUNITY_FAMILY_KEYS },
    ]) {
      const searchKeyCount = (lookupKeys: readonly string[]): number => {
        const plan = this.#projection.explain(opportunityLookupSql(lookupKeys, name), lookupKeys.map(() => ""));
        // A single indexed SEARCH must satisfy every equality and rowid ordering;
        // a scan, run-only prefix or temporary sort is not readiness.
        if (plan.length !== 1) return 0;
        const detail = plan[0]!.detail;
        const prefix = `SEARCH evidence_objects USING INDEX ${name} (`;
        if (!detail.startsWith(prefix) || !detail.endsWith(")")) return 0;
        const constraints = detail.slice(prefix.length, -1).split(" AND ");
        return constraints.every(constraint => /^(?:run_id|<expr>)=\?$/.test(constraint)) ? constraints.length : 0;
      };
      if (searchKeyCount(keys) !== keys.length)
        throw new Error(`Readonly store requires writer-prepared index search keys ${name}`);
      // EQP labels all expressions "<expr>". Removing each production equality
      // must reduce the search, so duplicate expressions cannot hide a missing key.
      for (let position = 0; position < keys.length; position++) {
        if (searchKeyCount(keys.filter((_, index) => index !== position)) >= keys.length)
          throw new Error(`Readonly store requires every writer-prepared index search key ${name}`);
      }
    }
    const invalidOrdinal = this.#database.query<{ invalid: number }, []>(
      "SELECT 1 AS invalid FROM skill_executions WHERE admission_ordinal IS NULL OR typeof(admission_ordinal)<>'integer' OR admission_ordinal<=0 LIMIT 1",
    ).get();
    if (invalidOrdinal) throw new Error("Readonly store requires writer-prepared execution admission ordinals");
    for (const row of this.#projection.query<{ run_id: string; payload: string }, []>(
      "SELECT run_id,payload FROM history_projection_checkpoints",
    ).iterate()) {
      const checkpoint = JSON.parse(row.payload) as ProjectionCheckpoint;
      assertProjectionCheckpoint(checkpoint);
      if (!this.getRun(row.run_id) || checkpoint.target_through > this.historySourceHighwater(row.run_id))
        throw new Error("Projection checkpoint exceeds its bound source ledger");
    }
  }

  snapshot<T>(operation: () => T): T {
    if (this.#closed) throw new Error("Readonly store is closed");
    return this.#projection.transaction(() => {
      // Pin derived first: its publications were accepted by an earlier source commit.
      this.#projection.query("SELECT run_id FROM history_projection_checkpoints LIMIT 1").get();
      return this.#database.transaction(() => {
        this.#database.query("SELECT value FROM store_metadata WHERE key='game_epoch'").get();
        return operation();
      }).deferred();
    }).deferred();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#projection !== this.#database) this.#projection.close();
    this.#database.close();
  }
}
