import type { Json } from "../shared/contracts.ts";
import type { ImprovementOpportunity } from "../shared/execution-evidence.ts";
import type {
  HistorySourceKind,
  HistorySourceRecord,
} from "./history-source.ts";
import { HISTORY_SOURCE_KINDS } from "./history-source.ts";
import type { StoreReadQueries } from "./store-read.ts";
import type { HistorySnapshotStore } from "./history-snapshot.ts";
import { HISTORY_LIMITS } from "./history-limits.ts";
import { improvementOpportunityCandidate } from "./program-feedback.ts";
import {
  indexObjectiveSource,
  stepObjectiveProjection,
} from "./history-objective.ts";
import {
  indexEvidenceSource,
  stepEvidenceProjection,
} from "./history-evidence.ts";

export const PROJECTION_COLLECTIONS = [
  "execution",
  "metric_population",
  "terminal",
  "action",
  "action_item",
  "metric_number",
  "metric_item",
  "target",
  "position",
  "metric_event",
  "observation",
  "trace_tail",
  "trace_applied",
  "trace_reason",
  "run_state",
  "outcome_event",
  "dirty_detection",
  "dirty_outcome",
  "dirty_objective",
  "objective_job",
  "dirty_evidence",
  "evidence_job",
  "model_call",
  "compatibility",
  "fact",
  "controller",
  "promotion",
  "goal",
  "goal_dependency",
  "goal_candidate",
  "goal_link",
  "evidence_action",
  "evidence_terminal",
  "evidence_effect",
  "pending_opportunity",
  "metric_update",
] as const;
export type ProjectionCollection = (typeof PROJECTION_COLLECTIONS)[number];
export type ProjectionRow = {
  collection: ProjectionCollection;
  key: string;
  owner_id: string | null;
  source_id: string | null;
  order_seq: number;
  tag: string | null;
  value: Json;
};
export type ProjectionQuery = {
  collection: ProjectionCollection;
  owner_id?: string | null;
  source_id?: string | null;
  tag?: string | null;
  after?: { order_seq: number; key: string };
  before_order?: number;
  after_order?: number;
  before_tag?: string;
  after_tag?: string;
  descending?: boolean;
  limit?: number;
  offset?: number;
};
export type ProjectionMutation =
  | { type: "put"; row: ProjectionRow }
  | { type: "delete"; collection: ProjectionCollection; key: string };
export type ProjectionPhase =
  | "bootstrap"
  | "index"
  | "expand"
  | "detect"
  | "objective"
  | "evidence"
  | "publish"
  | "idle";
export type ProjectionCheckpoint = {
  schema_version: 1;
  revision: number;
  generation: number;
  published_revision: number;
  source_through: number;
  target_through: number;
  phase: ProjectionPhase;
  job: Record<string, Json>;
  metric_change_seq: number;
  published_metric_change_seq: number;
};
export type ProjectionGeneration = {
  generation: number;
  revision: number;
  source_through: number;
  source_available: number;
  has_pending: boolean;
  metric_change_seq: number;
  opportunity_change_seq: number;
};
export type HistoryProjectionBatch = {
  before: ProjectionCheckpoint;
  after: ProjectionCheckpoint;
  patches: ProjectionMutation[];
  candidates: ImprovementOpportunity[];
  opportunity_bootstrap: { seq: number; value: ImprovementOpportunity }[];
  has_more: boolean;
};
export const HISTORY_PROJECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_projection_rows(run_id TEXT NOT NULL,collection TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL,owner_id TEXT,source_id TEXT,order_seq INTEGER NOT NULL,tag TEXT,payload TEXT,deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),PRIMARY KEY(run_id,collection,object_key,revision)) STRICT;
CREATE INDEX IF NOT EXISTS history_projection_order ON history_projection_rows(run_id,collection,order_seq,object_key,revision);
CREATE INDEX IF NOT EXISTS history_projection_owner ON history_projection_rows(run_id,collection,owner_id,order_seq,object_key,revision);
CREATE INDEX IF NOT EXISTS history_projection_source ON history_projection_rows(run_id,collection,source_id,order_seq,object_key,revision);
CREATE INDEX IF NOT EXISTS history_projection_tag ON history_projection_rows(run_id,collection,tag,order_seq,object_key,revision);
CREATE TABLE IF NOT EXISTS history_projection_checkpoints(run_id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE IF NOT EXISTS history_projection_generations(run_id TEXT NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,source_through INTEGER NOT NULL,metric_change_seq INTEGER NOT NULL,PRIMARY KEY(run_id,generation)) STRICT;
CREATE TABLE IF NOT EXISTS history_opportunity_visibility(run_id TEXT NOT NULL,opportunity_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(run_id,opportunity_id)) STRICT;
CREATE TABLE IF NOT EXISTS history_opportunity_updates(change_seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,opportunity_id TEXT NOT NULL,generation INTEGER NOT NULL,skill_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE INDEX IF NOT EXISTS history_opportunity_updates_run ON history_opportunity_updates(run_id,change_seq);
CREATE INDEX IF NOT EXISTS history_opportunity_updates_scope ON history_opportunity_updates(run_id,skill_id,version,change_seq);
CREATE INDEX IF NOT EXISTS history_opportunity_updates_object ON history_opportunity_updates(run_id,opportunity_id,change_seq);
CREATE TRIGGER IF NOT EXISTS history_opportunity_insert AFTER INSERT ON evidence_objects WHEN NEW.kind='opportunity' BEGIN
 INSERT INTO history_opportunity_updates(run_id,opportunity_id,generation,skill_id,version,payload) VALUES(NEW.run_id,NEW.object_key,COALESCE((SELECT generation FROM history_opportunity_visibility WHERE run_id=NEW.run_id AND opportunity_id=NEW.object_key),0),json_extract(NEW.payload,'$.version.skill_id'),json_extract(NEW.payload,'$.version.version'),NEW.payload);
END;
CREATE TRIGGER IF NOT EXISTS history_opportunity_update AFTER UPDATE ON evidence_objects WHEN NEW.kind='opportunity' AND OLD.payload<>NEW.payload BEGIN
 INSERT INTO history_opportunity_updates(run_id,opportunity_id,generation,skill_id,version,payload) VALUES(NEW.run_id,NEW.object_key,COALESCE((SELECT generation FROM history_opportunity_visibility WHERE run_id=NEW.run_id AND opportunity_id=NEW.object_key),0),json_extract(NEW.payload,'$.version.skill_id'),json_extract(NEW.payload,'$.version.version'),NEW.payload);
END;`;

export function assertProjectionCheckpoint(value: ProjectionCheckpoint): void {
  if (
    !value ||
    value.schema_version !== 1 ||
    ![
      "bootstrap",
      "index",
      "expand",
      "detect",
      "objective",
      "evidence",
      "publish",
      "idle",
    ].includes(value.phase)
  )
    throw new Error("Invalid projection checkpoint");
  for (const key of [
    "revision",
    "generation",
    "published_revision",
    "source_through",
    "target_through",
    "metric_change_seq",
    "published_metric_change_seq",
  ] as const)
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      throw new Error(`Invalid projection ${key}`);
  if (
    value.published_revision > value.revision ||
    value.source_through > value.target_through ||
    value.published_metric_change_seq > value.metric_change_seq ||
    !value.job ||
    typeof value.job !== "object" ||
    Array.isArray(value.job) ||
    Buffer.byteLength(JSON.stringify(value.job)) > 8192
  )
    throw new Error("Invalid projection progress");
}
/** A durable continuation must fit its next request, not merely its reply. */
export function projectionRequestFits(
  runId: string,
  checkpoint: ProjectionCheckpoint,
): boolean {
  return (
    Buffer.byteLength(
      JSON.stringify({
        id: Number.MAX_SAFE_INTEGER,
        query: {
          kind: "projection_batch",
          run_id: runId,
          checkpoint,
          work_limit: 128,
        },
      }) + "\n",
    ) <= HISTORY_LIMITS.requestBytes
  );
}
export function assertProjectionRow(row: ProjectionRow): void {
  if (
    !PROJECTION_COLLECTIONS.includes(row.collection) ||
    typeof row.key !== "string" ||
    !row.key ||
    !Number.isSafeInteger(row.order_seq) ||
    row.order_seq < 0 ||
    [row.owner_id, row.source_id, row.tag].some(
      (v) => v !== null && typeof v !== "string",
    )
  )
    throw new Error("Invalid normalized projection row");
  JSON.stringify(row.value, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Nonfinite projection data");
    return value;
  });
}
export function projectionCheckpointEqual(
  left: ProjectionCheckpoint,
  right: ProjectionCheckpoint,
): boolean {
  const encode = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => {
      if (item && typeof item === "object" && !Array.isArray(item))
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      return item;
    });
  return encode(left) === encode(right);
}
export function projectionCompare(a: ProjectionRow, b: ProjectionRow): number {
  return (
    a.order_seq - b.order_seq ||
    Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))
  );
}
export function projectionMatches(
  row: ProjectionRow,
  q: ProjectionQuery,
): boolean {
  const textCompare = (a: string, b: string) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b));
  return (
    row.collection === q.collection &&
    (q.owner_id === undefined || row.owner_id === q.owner_id) &&
    (q.source_id === undefined || row.source_id === q.source_id) &&
    (q.tag === undefined || row.tag === q.tag) &&
    (q.before_order === undefined || row.order_seq < q.before_order) &&
    (q.after_order === undefined || row.order_seq > q.after_order) &&
    (q.before_tag === undefined ||
      (row.tag !== null && textCompare(row.tag, q.before_tag) < 0)) &&
    (q.after_tag === undefined ||
      (row.tag !== null && textCompare(row.tag, q.after_tag) > 0)) &&
    (!q.after ||
      (row.order_seq === q.after.order_seq
        ? textCompare(row.key, q.after.key) * (q.descending ? -1 : 1) > 0
        : (row.order_seq - q.after.order_seq) * (q.descending ? -1 : 1) > 0))
  );
}

/** A single bounded, effect-free overlay. Atomic groups never consume half a source item. */
export class ProjectionDraft {
  readonly source: HistorySnapshotStore;
  readonly through: number;
  readonly before: ProjectionCheckpoint;
  next: ProjectionCheckpoint;
  full = false;
  private edits = new Map<string, ProjectionMutation>();
  private candidates: ImprovementOpportunity[] = [];
  private bootstrap: { seq: number; value: ImprovementOpportunity }[] = [];
  constructor(
    readonly store: StoreReadQueries,
    readonly runId: string,
    checkpoint: ProjectionCheckpoint,
  ) {
    assertProjectionCheckpoint(checkpoint);
    this.before = structuredClone(checkpoint);
    this.next = structuredClone(checkpoint);
    this.through = checkpoint.target_through;
    this.source = store.historySnapshot(runId, this.through);
  }
  private identity(collection: ProjectionCollection, key: string): string {
    return JSON.stringify([collection, key]);
  }
  get(collection: ProjectionCollection, key: string): ProjectionRow | null {
    const edit = this.edits.get(this.identity(collection, key));
    return edit
      ? edit.type === "put"
        ? structuredClone(edit.row)
        : null
      : this.store.historyProjectionRow(
          this.runId,
          this.before.revision,
          collection,
          key,
        );
  }
  page(query: ProjectionQuery): ProjectionRow[] {
    const limit = query.limit ?? 128,
      offset = query.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 128 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid projection page bounds");
    if (this.edits.size === 0)
      return this.store.historyProjectionRows(
        this.runId,
        this.before.revision,
        query,
      );
    const start =
      offset === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              offset - this.edits.size,
              Math.max(
                0,
                this.store.historyProjectionCount(
                  this.runId,
                  this.before.revision,
                  query,
                ) - 1,
              ),
            ),
          );
    const rows: ProjectionRow[] = [];
    let after = query.after,
      fetched = 0,
      boundary: ProjectionRow | undefined;
    const target = limit + 2 * this.edits.size;
    while (fetched < target) {
      const page = this.store.historyProjectionRows(
        this.runId,
        this.before.revision,
        {
          ...query,
          after,
          offset: fetched === 0 ? start : 0,
          limit: Math.min(128, target - fetched),
        },
      );
      boundary ??= page[0];
      for (const row of page)
        if (!this.edits.has(this.identity(row.collection, row.key)))
          rows.push(row);
      fetched += page.length;
      if (page.length === 0 || fetched >= target) break;
      const last = page.at(-1)!;
      after = { order_seq: last.order_seq, key: last.key };
    }
    let prefixDelta = 0;
    for (const edit of this.edits.values()) {
      const collection =
          edit.type === "put" ? edit.row.collection : edit.collection,
        key = edit.type === "put" ? edit.row.key : edit.key;
      if (collection !== query.collection) continue;
      const beforeBoundary = (row: ProjectionRow) =>
        start > 0 &&
        boundary !== undefined &&
        projectionCompare(row, boundary) * (query.descending ? -1 : 1) < 0;
      const old = this.store.historyProjectionRow(
        this.runId,
        this.before.revision,
        collection,
        key,
      );
      if (old && projectionMatches(old, query) && beforeBoundary(old))
        prefixDelta--;
      if (edit.type === "put" && projectionMatches(edit.row, query)) {
        if (beforeBoundary(edit.row)) prefixDelta++;
        else rows.push(structuredClone(edit.row));
      }
    }
    rows.sort((a, b) => projectionCompare(a, b) * (query.descending ? -1 : 1));
    const skip = offset - start - prefixDelta;
    return rows.slice(skip, skip + limit);
  }
  count(query: ProjectionQuery): number {
    let n = this.store.historyProjectionCount(
      this.runId,
      this.before.revision,
      query,
    );
    for (const edit of this.edits.values()) {
      const collection =
          edit.type === "put" ? edit.row.collection : edit.collection,
        key = edit.type === "put" ? edit.row.key : edit.key;
      const old = this.store.historyProjectionRow(
        this.runId,
        this.before.revision,
        collection,
        key,
      );
      if (old && projectionMatches(old, query)) n--;
      if (edit.type === "put" && projectionMatches(edit.row, query)) n++;
    }
    return n;
  }
  private batch(hasMore: boolean): HistoryProjectionBatch {
    return {
      before: this.before,
      after: this.next,
      patches: [...this.edits.values()],
      candidates: this.candidates,
      opportunity_bootstrap: this.bootstrap,
      has_more: hasMore,
    };
  }
  private fits(): boolean {
    return (
      this.edits.size <= 64 &&
      this.candidates.length <= 16 &&
      this.bootstrap.length <= 128 &&
      Buffer.byteLength(JSON.stringify(this.batch(true))) <= 64000 &&
      Buffer.byteLength(JSON.stringify(this.next.job)) <= 8192 &&
      projectionRequestFits(this.runId, this.next)
    );
  }
  atomic(operation: () => boolean): boolean {
    const edits = new Map(this.edits),
      candidates = this.candidates.slice(),
      bootstrap = this.bootstrap.slice(),
      next = structuredClone(this.next);
    try {
      if (operation() && this.fits()) return true;
    } catch (error) {
      this.edits = edits;
      this.candidates = candidates;
      this.bootstrap = bootstrap;
      this.next = next;
      throw error;
    }
    this.edits = edits;
    this.candidates = candidates;
    this.bootstrap = bootstrap;
    this.next = next;
    this.full = true;
    return false;
  }
  put(row: ProjectionRow): boolean {
    assertProjectionRow(row);
    const id = this.identity(row.collection, row.key),
      old = this.edits.get(id);
    this.edits.set(id, { type: "put", row: structuredClone(row) });
    if (this.fits()) return true;
    if (old) this.edits.set(id, old);
    else this.edits.delete(id);
    this.full = true;
    return false;
  }
  delete(collection: ProjectionCollection, key: string): boolean {
    const id = this.identity(collection, key),
      old = this.edits.get(id);
    this.edits.set(id, { type: "delete", collection, key });
    if (this.fits()) return true;
    if (old) this.edits.set(id, old);
    else this.edits.delete(id);
    this.full = true;
    return false;
  }
  captureOpportunity(candidate: ImprovementOpportunity): boolean {
    this.candidates.push(candidate);
    if (this.fits()) return true;
    this.candidates.pop();
    this.full = true;
    return false;
  }
  bootstrapOpportunity(entry: {
    seq: number;
    value: ImprovementOpportunity;
  }): boolean {
    this.bootstrap.push(entry);
    if (this.fits()) return true;
    this.bootstrap.pop();
    this.full = true;
    return false;
  }
  finish(hasMore: boolean): HistoryProjectionBatch {
    const changed =
      this.edits.size > 0 ||
      this.candidates.length > 0 ||
      this.bootstrap.length > 0 ||
      !projectionCheckpointEqual(this.next, this.before);
    if (hasMore && !changed && this.full)
      throw new Error(
        "One projection item exceeds the bounded atomic envelope",
      );
    if (changed) this.next.revision = this.before.revision + 1;
    assertProjectionCheckpoint(this.next);
    if (!this.fits())
      throw new Error("Projection batch exceeds response budget");
    return this.batch(hasMore);
  }
}

const outcomeTypes = new Set([
  "skill.closed",
  "skill.failed",
  "skill.blocked",
  "skill.unknown",
  "skill.succeeded",
  "learning.death_episode",
]);
function indexSource(
  draft: ProjectionDraft,
  kind: HistorySourceKind,
  record: HistorySourceRecord | null,
  key: string,
): boolean {
  if (
    !indexObjectiveSource(draft, kind, record, key) ||
    !indexEvidenceSource(draft, kind, record, key)
  )
    return false;
  if (kind === "execution")
    return draft.put({
      collection: "dirty_detection",
      key,
      owner_id: key,
      source_id: null,
      order_seq: record?.ordinal ?? 0,
      tag: null,
      value: null,
    });
  if (kind !== "event") return true;
  const prior = draft.get("outcome_event", key);
  const event = record
    ? draft.store.decodeHistorySource("event", record)
    : null;
  if (!event || !outcomeTypes.has(event.type)) {
    return !prior || draft.delete("outcome_event", key);
  }
  const details =
    event.details &&
    typeof event.details === "object" &&
    !Array.isArray(event.details)
      ? event.details
      : null;
  const owner = details?.execution_id ?? details?.root_execution_id;
  if (typeof owner !== "string")
    return !prior || draft.delete("outcome_event", key);
  return (
    draft.put({
      collection: "outcome_event",
      key,
      owner_id: owner,
      source_id: key,
      order_seq: event.event_seq,
      tag: null,
      value: null,
    }) &&
    draft.put({
      collection: "dirty_detection",
      key: owner,
      owner_id: owner,
      source_id: null,
      order_seq: event.event_seq,
      tag: null,
      value: null,
    })
  );
}

export function prepareHistoryProjectionBatch(
  store: StoreReadQueries,
  runId: string,
  checkpoint: ProjectionCheckpoint,
  workLimit = 128,
): HistoryProjectionBatch {
  if (!Number.isSafeInteger(workLimit) || workLimit < 1 || workLimit > 128)
    throw new Error("Invalid projection work limit");
  const saved = store.historyProjectionCheckpoint(runId);
  if (!saved || !projectionCheckpointEqual(saved, checkpoint))
    throw new Error("Projection checkpoint changed before preview");
  const d = new ProjectionDraft(store, runId, checkpoint);
  for (let work = 0; work < workLimit && !d.full; work++) {
    if (d.next.phase === "idle") break;
    if (d.next.phase === "bootstrap") {
      const cursor = (d.next.job.bootstrap ?? { kind: 0, after: 0 }) as {
        kind: number;
        after: number;
        through_key?: number;
      };
      if (cursor.kind >= HISTORY_SOURCE_KINDS.length) {
        delete d.next.job.bootstrap;
        d.next.phase = "index";
        break;
      }
      const kind = HISTORY_SOURCE_KINDS[cursor.kind]!;
      const page = store.historySourcePage(
        runId,
        kind,
        d.through,
        cursor.after,
        cursor.through_key,
        1,
      );
      if (!page.records.length) {
        d.next.job.bootstrap = page.has_more
          ? {
              kind: cursor.kind,
              after: page.next_after,
              through_key: page.through_key,
            }
          : { kind: cursor.kind + 1, after: 0 };
        continue;
      }
      const record = page.records[0]!;
      if (!d.atomic(() => indexSource(d, kind, record, record.source_key)))
        break;
      d.next.job.bootstrap = {
        kind: cursor.kind,
        after: record.key_seq,
        through_key: page.through_key,
      };
      if (!page.has_more)
        d.next.job.bootstrap = { kind: cursor.kind + 1, after: 0 };
      continue;
    }
    if (d.next.phase === "index") {
      const after =
        typeof d.next.job.index_after === "number"
          ? d.next.job.index_after
          : d.next.source_through;
      const page = store.historySourceChanges(runId, after, d.through, 1);
      if (!page.records.length) {
        delete d.next.job.index_after;
        d.next.phase = "expand";
        break;
      }
      const change = page.records[0]!,
        record = store.historySourceRecord(
          runId,
          change.kind,
          change.source_key,
          d.through,
        );
      if (
        !d.atomic(() => indexSource(d, change.kind, record, change.source_key))
      )
        break;
      d.next.job.index_after = change.change_seq;
      continue;
    }
    if (d.next.phase === "expand") {
      const dirty = d.page({ collection: "dirty_detection", limit: 1 })[0];
      if (!dirty) {
        delete d.next.job.expand;
        d.next.phase = "detect";
        break;
      }
      const cursor = d.next.job.expand as
        { key: string; after?: { order_seq: number; key: string } } | undefined;
      const rows = d.page({
        collection: "outcome_event",
        owner_id: dirty.key,
        after: cursor?.key === dirty.key ? cursor.after : undefined,
        limit: 1,
      });
      if (!rows.length) {
        if (!d.delete("dirty_detection", dirty.key)) break;
        delete d.next.job.expand;
        continue;
      }
      const row = rows[0]!;
      if (!d.put({ ...row, collection: "dirty_outcome" })) break;
      d.next.job.expand = {
        key: dirty.key,
        after: { order_seq: row.order_seq, key: row.key },
      };
      continue;
    }
    if (d.next.phase === "detect") {
      const row = d.page({ collection: "dirty_outcome", limit: 1 })[0];
      if (!row) {
        d.next.phase = "objective";
        break;
      }
      if (
        !d.atomic(() => {
          const record = store.historySourceRecord(
            runId,
            "event",
            row.key,
            d.through,
          );
          const candidate = record
            ? improvementOpportunityCandidate(
                d.source,
                runId,
                store.decodeHistorySource("event", record),
              )
            : null;
          return (
            (!candidate ||
              d.get("pending_opportunity", candidate.opportunity_id) !== null ||
              store.opportunity(runId, candidate.opportunity_id) !== null ||
              (d.captureOpportunity(candidate) &&
                d.put({
                  collection: "pending_opportunity",
                  key: candidate.opportunity_id,
                  owner_id: candidate.execution_id,
                  source_id: row.key,
                  order_seq: row.order_seq,
                  tag: null,
                  value: candidate as unknown as Json,
                }))) &&
            d.delete("dirty_outcome", row.key)
          );
        })
      )
        break;
      continue;
    }
    if (d.next.phase === "objective") {
      if (!stepObjectiveProjection(d) && !d.full) {
        d.next.phase = "evidence";
        break;
      }
      continue;
    }
    if (d.next.phase === "evidence") {
      if (!stepEvidenceProjection(d) && !d.full) {
        d.next.phase = "publish";
        break;
      }
      continue;
    }
    if (d.next.phase === "publish") {
      const pending = d.page({
        collection: "pending_opportunity",
        limit: 1,
      })[0];
      if (pending) {
        if (!d.delete("pending_opportunity", pending.key)) break;
        continue;
      }
      const after =
        typeof d.next.job.opportunity_after === "number"
          ? d.next.job.opportunity_after
          : 0;
      const old = store.historyOpportunityBootstrapPage(runId, after, 1)[0];
      if (old) {
        if (!d.bootstrapOpportunity(old)) break;
        d.next.job.opportunity_after = old.seq;
        continue;
      }
      delete d.next.job.publish_after;
      d.next.generation++;
      d.next.source_through = d.through;
      d.next.published_revision = d.before.revision + 1;
      d.next.published_metric_change_seq = d.next.metric_change_seq;
      d.next.phase = "idle";
      break;
    }
  }
  return d.finish(d.next.phase !== "idle");
}
