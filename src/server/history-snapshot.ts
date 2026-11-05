import type { ActivityEvent } from "../shared/contracts.ts";
import type { TracePage, TraceRecord } from "../shared/execution-evidence.ts";
import type {
  SkillExecutionView,
  SkillRef,
  SkillView,
} from "../shared/programs.ts";
import type {
  HistorySourceKind,
  HistorySourcePage,
  HistorySourceRecord,
} from "./history-source.ts";
import type { ProgramEvidenceReadStore } from "./program-evidence.ts";
import type { StoredAction, StoredRun } from "./store.ts";

/** Decoding belongs to StoreReadQueries, including legacy defaults and artifact verification. */
export type HistoryDecodedSource = {
  run: StoredRun;
  action: StoredAction;
  execution: SkillExecutionView;
  event: ActivityEvent;
  trace: TraceRecord;
  trace_budget: TracePage["budget"];
  skill: SkillView;
};

/** Read-only source capability: no writer preparation, live queries, or authority admission. */
export interface SnapshotSourceStore {
  historySourceRecord(
    runId: string,
    kind: HistorySourceKind,
    key: string,
    through: number,
  ): HistorySourceRecord | null;
  historySourcePage(
    runId: string,
    kind: HistorySourceKind,
    through: number,
    after?: number,
    throughKey?: number,
    limit?: number,
  ): HistorySourcePage;
  decodeHistorySource<K extends HistorySourceKind>(
    kind: K,
    record: HistorySourceRecord,
  ): HistoryDecodedSource[K];
  historyTraceBudget(row: null): TracePage["budget"];
  packHistoryTracePage(
    rows: readonly { trace_seq: number; payload: string }[],
    budget: TracePage["budget"],
    after: number,
    limit: number,
  ): TracePage;
}

/**
 * Pinned full-scan oracle, not an incremental reducer or a production query fallback.
 * Only immutable raw rows are retained. Every returned value is decoded afresh, so
 * a skill read always rechecks the bytes of its external content-addressed artifact.
 */
export class HistorySnapshotStore implements ProgramEvidenceReadStore {
  readonly #sources = new Map<
    HistorySourceKind,
    readonly HistorySourceRecord[]
  >();

  constructor(
    private readonly store: SnapshotSourceStore,
    private readonly runId: string,
    private readonly through: number,
  ) {
    if (!Number.isSafeInteger(through) || through < 0)
      throw new Error("Invalid history source boundary");
    // Source paging rejects an incomplete baseline bootstrap without preparing it.
    // Check even when the caller subsequently performs only direct key lookups.
    this.sources("run");
  }

  private sources(kind: HistorySourceKind): readonly HistorySourceRecord[] {
    const cached = this.#sources.get(kind);
    if (cached) return cached;
    const records: HistorySourceRecord[] = [];
    let after = 0;
    let throughKey: number | undefined;
    while (true) {
      const page = this.store.historySourcePage(
        this.runId,
        kind,
        this.through,
        after,
        throughKey,
        128,
      );
      throughKey ??= page.through_key;
      records.push(...page.records);
      if (!page.has_more) break;
      after = page.next_after;
    }
    // Key discovery order is not source row order, especially after late updates.
    records.sort((left, right) => left.ordinal - right.ordinal);
    this.#sources.set(kind, records);
    return records;
  }

  private source<K extends HistorySourceKind>(
    kind: K,
    key: string,
  ): HistoryDecodedSource[K] | null {
    const record = this.store.historySourceRecord(
      this.runId,
      kind,
      key,
      this.through,
    );
    return record ? this.store.decodeHistorySource(kind, record) : null;
  }

  private assertRun(runId: string | null): void {
    if (runId === null || runId !== this.runId)
      throw new Error("History snapshot selector must match its pinned run");
  }

  getRun(id: string): StoredRun | null {
    this.assertRun(id);
    const record = this.sources("run").find((row) => row.source_key === id);
    return record ? this.store.decodeHistorySource("run", record) : null;
  }

  getAction(runId: string, id: string): StoredAction | null {
    this.assertRun(runId);
    return this.source("action", id);
  }

  skill(runId: string, ref: SkillRef): SkillView {
    this.assertRun(runId);
    const value = this.source(
      "skill",
      JSON.stringify([ref.skill_id, ref.version]),
    );
    if (!value) throw new Error("Skill version not found in this run");
    return value;
  }

  skillExecution(
    runId: string,
    lookup: { start_key: string } | { execution_id: string },
  ): SkillExecutionView | null {
    this.assertRun(runId);
    if (!("start_key" in lookup))
      return this.source("execution", lookup.execution_id);
    const record = this.sources("execution").find(
      (row) => row.columns.start_key === lookup.start_key,
    );
    return record ? this.store.decodeHistorySource("execution", record) : null;
  }

  allSkillExecutions(runId: string): SkillExecutionView[] {
    this.assertRun(runId);
    return this.sources("execution").map((row) =>
      this.store.decodeHistorySource("execution", row),
    );
  }

  eventsAfter(
    runId: string | null,
    after: number,
    limit: number,
  ): ActivityEvent[] {
    // A per-run source boundary cannot make a truthful global event snapshot.
    this.assertRun(runId);
    const cap = Math.max(1, Math.min(500, limit));
    // SQLite LIMIT rejects fractional/NaN limits rather than truncating them.
    if (!Number.isInteger(cap)) throw new Error("Invalid event limit");
    return this.sources("event")
      .filter((row) => (row.columns.event_seq as number) > after)
      .sort(
        (left, right) =>
          (left.columns.event_seq as number) -
          (right.columns.event_seq as number),
      )
      .slice(0, cap)
      .map((row) => this.store.decodeHistorySource("event", row));
  }

  tracePage(
    runId: string,
    after = 0,
    limit = 100,
    executionId?: string,
  ): TracePage {
    this.assertRun(runId);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw new Error("Invalid trace cursor or limit");
    const budget =
      this.source("trace_budget", this.runId) ??
      this.store.historyTraceBudget(null);
    const rows: { trace_seq: number; payload: string }[] = [];
    const candidates = this.sources("trace")
      .filter((row) => (row.columns.trace_seq as number) > after)
      .sort(
        (left, right) =>
          (left.columns.trace_seq as number) -
          (right.columns.trace_seq as number),
      );
    for (const row of candidates) {
      if (executionId) {
        const trace = this.store.decodeHistorySource("trace", row);
        if (
          trace.execution_id !== executionId &&
          trace.root_execution_id !== executionId
        )
          continue;
      }
      rows.push({
        trace_seq: row.columns.trace_seq as number,
        payload: row.columns.payload as string,
      });
      if (rows.length === Math.min(limit, 500) + 1) break;
    }
    // Shared live-store packing preserves the complete envelope byte limit,
    // next_after/has_more behavior, omissions, and canonical trace decoding.
    return this.store.packHistoryTracePage(rows, budget, after, limit);
  }
}
