import type { SQLQueryBindings, Statement } from "bun:sqlite";
import type { Json } from "../shared/contracts.ts";
import {
  HISTORY_SOURCE_KINDS,
  HISTORY_SOURCE_REGISTRY,
  type HistorySourceChange,
  type HistorySourceChanges,
  type HistorySourceKind,
  type HistorySourcePage,
  type HistorySourceRecord,
} from "./history-source.ts";
import { RuntimeFault } from "./runtime-fault.ts";

/** Retrieval code has no mutation SQL capability, even when backed by the writer. */
export interface HistorySourceReadDatabase {
  query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Pick<Statement<Row, Params>, "get" | "all">;
  transaction<T>(operation: () => T): { deferred(): T };
}

type SourceVersion = {
  change_seq: number;
  ordinal: number;
  present: number;
  payload: string | null;
};
type SourceKey = { key_seq: number; source_key: string };
type SourceRow = {
  ordinal: number;
  source_key: string;
  run_id: string;
} & Record<string, Json>;

function cursor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid history source ${label}`);
}

function pageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid history source page limit");
  return Math.min(limit, 128);
}

function sourceKind(kind: HistorySourceKind): void {
  if (!(HISTORY_SOURCE_KINDS as readonly string[]).includes(kind))
    throw new Error("Invalid history source kind");
}

/** Raw source MVCC retrieval; authority decoding remains exclusively in StoreReadQueries. */
export class HistorySourceReadQueries {
  constructor(private readonly database: HistorySourceReadDatabase) {}

  highwater(runId: string): number {
    const value = this.database
      .query<{ seq: number }, [string]>(
        "SELECT COALESCE(MAX(change_seq),0) AS seq FROM history_source_changes WHERE run_id=?",
      )
      .get(runId)!.seq;
    cursor(value, "highwater");
    return value;
  }

  private boundary(runId: string, through: number): void {
    cursor(through, "boundary");
    if (through > this.highwater(runId))
      throw new Error("History source boundary exceeds highwater");
  }

  changes(
    runId: string,
    after: number,
    through?: number,
    limit = 128,
  ): HistorySourceChanges {
    cursor(after, "change cursor");
    const cap = pageLimit(limit);
    return this.database
      .transaction(() => {
        const highwater = this.highwater(runId);
        const boundary = through ?? highwater;
        cursor(boundary, "boundary");
        if (boundary < after || boundary > highwater)
          throw new Error("Invalid history source change boundary");
        const records = this.database
          .query<HistorySourceChange, [string, number, number, number]>(
            "SELECT change_seq,run_id,kind,source_key FROM history_source_changes WHERE run_id=? AND change_seq>? AND change_seq<=? ORDER BY change_seq LIMIT ?",
          )
          .all(runId, after, boundary, cap);
        for (const record of records) {
          cursor(record.change_seq, "change sequence");
          sourceKind(record.kind);
        }
        const next = records.at(-1)?.change_seq ?? after;
        const hasMore = !!this.database
          .query<{ pending: number }, [string, number, number]>(
            "SELECT 1 AS pending FROM history_source_changes WHERE run_id=? AND change_seq>? AND change_seq<=? LIMIT 1",
          )
          .get(runId, next, boundary);
        return {
          records,
          next_after: hasMore ? next : boundary,
          through: boundary,
          has_more: hasMore,
        };
      })
      .deferred();
  }

  record(
    runId: string,
    kind: HistorySourceKind,
    key: string,
    through: number,
  ): HistorySourceRecord | null {
    sourceKind(kind);
    if (typeof key !== "string") throw new Error("Invalid history source key");
    cursor(through, "boundary");
    return this.database
      .transaction(() => {
        this.boundary(runId, through);
        return this.recordAt(runId, kind, key, through);
      })
      .deferred();
  }

  private backing(
    runId: string,
    kind: HistorySourceKind,
    key: string,
  ): SourceRow | null {
    const row = this.database
      .query<SourceRow, [string, string]>(
        HISTORY_SOURCE_REGISTRY[kind].lookupSql,
      )
      .get(runId, key);
    if (!row) return null;
    if (
      row.run_id !== runId ||
      row.source_key !== key ||
      !Number.isSafeInteger(row.ordinal) ||
      row.ordinal <= 0
    )
      throw new Error("Corrupt history source backing identity or ordinal");
    return row;
  }

  private rawRecord(
    kind: HistorySourceKind,
    key: string,
    ordinal: number,
    row: Record<string, Json>,
  ): HistorySourceRecord {
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0)
      throw new Error("Corrupt history source ordinal");
    const columns: Record<string, Json> = {};
    for (const column of HISTORY_SOURCE_REGISTRY[kind].columns) {
      if (!Object.hasOwn(row, column))
        throw new Error("Corrupt history source raw columns");
      columns[column] = row[column]!;
    }
    return { source_key: key, ordinal, columns };
  }

  private recordAt(
    runId: string,
    kind: HistorySourceKind,
    key: string,
    through: number,
  ): HistorySourceRecord | null {
    const version = this.database
      .query<SourceVersion, [string, HistorySourceKind, string, number]>(
        "SELECT change_seq,ordinal,present,payload FROM history_source_versions WHERE run_id=? AND kind=? AND source_key=? AND change_seq<=? ORDER BY change_seq DESC LIMIT 1",
      )
      .get(runId, kind, key, through);
    if (!version) {
      // Positive revisions without a preceding version zero mean this key did not yet exist.
      if (
        this.database
          .query<{ present: number }, [string, HistorySourceKind, string]>(
            "SELECT 1 AS present FROM history_source_versions WHERE run_id=? AND kind=? AND source_key=? LIMIT 1",
          )
          .get(runId, kind, key)
      )
        return null;
      const original = this.backing(runId, kind, key);
      return original
        ? this.rawRecord(kind, key, original.ordinal, original)
        : null;
    }
    cursor(version.change_seq, "version sequence");
    if (version.present === 0) return null;
    if (version.present !== 1)
      throw new Error("Corrupt history source presence");
    if (version.payload !== null) {
      const columns: unknown = JSON.parse(version.payload);
      if (!columns || typeof columns !== "object" || Array.isArray(columns))
        throw new Error("Corrupt history source sealed payload");
      return this.rawRecord(
        kind,
        key,
        version.ordinal,
        columns as Record<string, Json>,
      );
    }
    if (
      this.database
        .query<
          { present: number },
          [string, HistorySourceKind, string, number]
        >(
          "SELECT 1 AS present FROM history_source_versions WHERE run_id=? AND kind=? AND source_key=? AND change_seq>? LIMIT 1",
        )
        .get(runId, kind, key, version.change_seq)
    )
      throw new Error("Corrupt unsealed historical source version");
    const current = this.backing(runId, kind, key);
    if (!current || current.ordinal !== version.ordinal)
      throw new Error("Corrupt history source live backing row");
    return this.rawRecord(kind, key, version.ordinal, current);
  }

  page(
    runId: string,
    kind: HistorySourceKind,
    through: number,
    after = 0,
    throughKey?: number,
    limit = 128,
  ): HistorySourcePage {
    sourceKind(kind);
    cursor(through, "boundary");
    cursor(after, "key cursor");
    if (throughKey !== undefined) cursor(throughKey, "key boundary");
    const cap = pageLimit(limit);
    return this.database
      .transaction(() => {
        this.boundary(runId, through);
        const bootstrap = this.database
          .query<
            { kind: string; through_ordinal: number; after_ordinal: number },
            []
          >(
            "SELECT kind,through_ordinal,after_ordinal FROM history_source_bootstrap",
          )
          .all();
        if (
          bootstrap.length !== HISTORY_SOURCE_KINDS.length ||
          HISTORY_SOURCE_KINDS.some(
            (kind) => !bootstrap.some((row) => row.kind === kind),
          ) ||
          bootstrap.some(
            (row) =>
              !Number.isSafeInteger(row.through_ordinal) ||
              !Number.isSafeInteger(row.after_ordinal) ||
              row.after_ordinal < 0 ||
              row.through_ordinal < row.after_ordinal,
          )
        )
          throw new Error("Corrupt history source bootstrap state");
        if (bootstrap.some((row) => row.after_ordinal < row.through_ordinal))
          throw new RuntimeFault(
            "conflict",
            "History source baseline key bootstrap is pending",
          );
        const highwater = this.database
          .query<{ seq: number }, [string, HistorySourceKind]>(
            "SELECT COALESCE(MAX(key_seq),0) AS seq FROM history_source_keys WHERE run_id=? AND kind=?",
          )
          .get(runId, kind)!.seq;
        cursor(highwater, "key highwater");
        const boundary = throughKey ?? highwater;
        if (after > boundary || boundary > highwater)
          throw new Error("Invalid history source key boundary");
        const keys = this.database
          .query<
            SourceKey,
            [string, HistorySourceKind, number, number, number]
          >(
            "SELECT key_seq,source_key FROM history_source_keys WHERE run_id=? AND kind=? AND key_seq>? AND key_seq<=? ORDER BY key_seq LIMIT ?",
          )
          .all(runId, kind, after, boundary, cap);
        const records: HistorySourcePage["records"] = [];
        for (const key of keys) {
          cursor(key.key_seq, "key sequence");
          const record = this.recordAt(runId, kind, key.source_key, through);
          if (record) records.push({ ...record, key_seq: key.key_seq });
        }
        const next = keys.at(-1)?.key_seq ?? after;
        const hasMore = !!this.database
          .query<
            { pending: number },
            [string, HistorySourceKind, number, number]
          >(
            "SELECT 1 AS pending FROM history_source_keys WHERE run_id=? AND kind=? AND key_seq>? AND key_seq<=? LIMIT 1",
          )
          .get(runId, kind, next, boundary);
        return {
          records,
          next_after: hasMore ? next : boundary,
          through_key: boundary,
          has_more: hasMore,
        };
      })
      .deferred();
  }
}
