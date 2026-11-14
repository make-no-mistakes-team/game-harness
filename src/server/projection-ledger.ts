import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Json } from "../shared/contracts.ts";
import type { ImprovementOpportunity } from "../shared/execution-evidence.ts";
import { canonical } from "./store-json.ts";
import { StoreDatabase } from "./store-database.ts";
import { ReadonlyStore, type StoreReadLocation } from "./store-read.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { improvementOpportunityCandidate } from "./program-feedback.ts";
import { assertProjectionCheckpoint, assertProjectionRow, projectionRequestFits, PROJECTION_COLLECTIONS, type HistoryProjectionBatch, type ProjectionCheckpoint } from "./history-projection.ts";

export interface ProjectionIdentity { source_id: string; projection_id: string }
/** Bounded metadata commits only; no caller SQL, source reduction or derived writes. */
export interface ProjectionControl {
  publication(hash: string): { batch_hash: string } | null;
  acceptPublication(runId: string, hash: string, sourceThrough: number): void;
  appendAudit(receiptId: string, runId: string, payload: string): number;
  publishAudit(sequence: number): void;
}

/** One derived writer; authoritative source access stays readonly. */
export class ProjectionLedger extends ReadonlyStore {
  private readonly projectionDb: StoreDatabase;
  constructor(location: StoreReadLocation, private readonly identity: ProjectionIdentity, private readonly control: ProjectionControl, writer?: StoreDatabase) {
    super(location);
    if (!location.projection) { super.close(); throw new Error("A separated projection location is required"); }
    const database = writer ?? new StoreDatabase(new Database(location.projection, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_URI));
    try {
      const binding = database.query<ProjectionIdentity & {ready: number}, []>("SELECT source_id,projection_id,ready FROM projection_binding WHERE singleton=1").get();
      if (!binding || binding.ready !== 1 || binding.source_id !== identity.source_id || binding.projection_id !== identity.projection_id)
        throw new Error("Projection writer identity does not match its source owner");
      database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.projectionDb = database;
      this.useProjectionDatabase(database);
    } catch (error) { database.close(); super.close(); throw error; }
  }

  private insertOpportunity(value: ImprovementOpportunity): void {
    const payload = canonical(value);
    if (Buffer.byteLength(payload) > 65536) throw new Error("Evidence object exceeds 64 KiB budget");
    this.projectionDb.query("INSERT OR IGNORE INTO evidence_objects(run_id,kind,object_key,payload) VALUES(?,'opportunity',?,?)")
      .run(value.run_id, value.opportunity_id, payload);
  }

  /** Replaying an immutable outbox receipt never appends a second canonical event. */
  drainAudit(): void {
    for (;;) {
      const rows = this.projectionDb.query<{receipt_id: string; run_id: string; payload: string}, []>(
        "SELECT receipt_id,run_id,payload FROM projection_audit_outbox WHERE event_seq IS NULL ORDER BY outbox_seq LIMIT 64",
      ).all();
      if (!rows.length) return;
      for (const row of rows) {
        const sequence = this.control.appendAudit(row.receipt_id, row.run_id, row.payload);
        this.projectionDb.query("UPDATE projection_audit_outbox SET event_seq=? WHERE receipt_id=? AND event_seq IS NULL").run(sequence, row.receipt_id);
        this.control.publishAudit(sequence);
      }
    }
  }

  saveOpportunity(value: ImprovementOpportunity): ImprovementOpportunity {
    if (!this.getRun(value.run_id)) throw new Error("Run not found");
    this.insertOpportunity(value);
    return this.opportunity(value.run_id, value.opportunity_id)!;
  }

  beginHistoryProjection(runId: string, desiredThrough?: number): ProjectionCheckpoint {
    return this.projectionDb.transaction(() => {
      if (!this.getRun(runId)) throw new RuntimeFault("not_found", "Run not found");
      const available = this.historySourceHighwater(runId), desired = desiredThrough ?? available;
      if (!Number.isSafeInteger(desired) || desired < 0 || desired > available) throw new Error("Invalid history projection frontier");
      const existing = this.historyProjectionCheckpoint(runId);
      const checkpoint: ProjectionCheckpoint = existing ? structuredClone(existing) : {
        schema_version: 1, revision: 0, generation: 0, published_revision: 0, source_through: 0,
        target_through: desired, phase: "bootstrap", job: {}, metric_change_seq: 0, published_metric_change_seq: 0,
      };
      if (existing && desired > checkpoint.target_through && ["bootstrap", "index", "expand", "detect", "idle"].includes(checkpoint.phase)) {
        checkpoint.target_through = desired;
        if (checkpoint.phase !== "bootstrap") {
          checkpoint.phase = "index";
          checkpoint.job.index_after ??= checkpoint.source_through;
          delete checkpoint.job.expand;
        }
        checkpoint.revision++;
      }
      assertProjectionCheckpoint(checkpoint);
      if (!projectionRequestFits(runId, checkpoint))
        throw new RuntimeFault("budget_exceeded", "History checkpoint cannot fit its next request");
      if (!existing) this.projectionDb.query("INSERT INTO history_projection_checkpoints(run_id,payload) VALUES(?,?)").run(runId, canonical(checkpoint));
      else if (canonical(existing) !== canonical(checkpoint)) this.projectionDb.query("UPDATE history_projection_checkpoints SET payload=? WHERE run_id=? AND payload=?").run(canonical(checkpoint), runId, canonical(existing));
      return checkpoint;
    }).immediate();
  }

  commitHistoryProjectionBatch(runId: string, batch: HistoryProjectionBatch): void {
    assertProjectionCheckpoint(batch.before);
    assertProjectionCheckpoint(batch.after);
    if (!projectionRequestFits(runId, batch.after))
      throw new RuntimeFault("budget_exceeded", "History checkpoint cannot fit its next request");
    if (!Array.isArray(batch.patches) || batch.patches.length > 64 || !Array.isArray(batch.candidates) || batch.candidates.length > 16 ||
      !Array.isArray(batch.opportunity_bootstrap) || batch.opportunity_bootstrap.length > 128 || Buffer.byteLength(JSON.stringify(batch)) > 64000)
      throw new Error("History projection batch exceeds bounded envelope");
    const changed = canonical(batch.before) !== canonical(batch.after) || batch.patches.length > 0 || batch.candidates.length > 0 || batch.opportunity_bootstrap.length > 0;
    const publication = batch.after.generation === batch.before.generation + 1;
    const phases = ["bootstrap", "index", "expand", "detect", "objective", "evidence", "publish", "idle"];
    const phaseAdvance = phases.indexOf(batch.after.phase) - phases.indexOf(batch.before.phase);
    if (batch.after.revision !== batch.before.revision + (changed ? 1 : 0) || batch.after.target_through !== batch.before.target_through ||
      (phaseAdvance !== 0 && phaseAdvance !== 1) || (publication && batch.before.phase !== "publish") ||
      batch.after.metric_change_seq < batch.before.metric_change_seq || batch.after.generation !== batch.before.generation + (publication ? 1 : 0) ||
      batch.has_more !== (batch.after.phase !== "idle") ||
      (!publication && (batch.after.source_through !== batch.before.source_through || batch.after.published_revision !== batch.before.published_revision || batch.after.published_metric_change_seq !== batch.before.published_metric_change_seq)) ||
      (publication && (batch.after.phase !== "idle" || batch.after.source_through !== batch.before.target_through || batch.after.published_revision !== batch.after.revision || batch.after.published_metric_change_seq !== batch.after.metric_change_seq)))
      throw new Error("Invalid history projection progress transition");
    const identities = new Set<string>();
    for (const patch of batch.patches) {
      const collection = patch.type === "put" ? patch.row.collection : patch.collection, key = patch.type === "put" ? patch.row.key : patch.key;
      if (!["put", "delete"].includes(patch.type) || !PROJECTION_COLLECTIONS.includes(collection) || typeof key !== "string" || !key) throw new Error("Invalid projection mutation scope");
      if (patch.type === "put") assertProjectionRow(patch.row);
      if (patch.type === "put" && collection === "pending_opportunity" &&
        !batch.candidates.some(candidate => candidate.opportunity_id === key && canonical(candidate) === canonical(patch.row.value)))
        throw new Error("Pending opportunity lacks an exact validated capture");
      if (patch.type === "put" && collection === "metric_update" &&
        (patch.row.order_seq <= batch.before.metric_change_seq || patch.row.order_seq > batch.after.metric_change_seq))
        throw new Error("Metric replacement is outside the batch change frontier");
      const identity = canonical([collection, key]);
      if (identities.has(identity)) throw new Error("Duplicate projection mutation key");
      identities.add(identity);
    }
    const batchHash = createHash("sha256").update(canonical([this.identity.projection_id, runId, batch])).digest("hex");
    if (batch.candidates.length) {
      const accepted = this.control.publication(batchHash);
      if (!accepted) {
        const available = this.snapshot(() => {
          const source = this;
      for (const candidate of batch.candidates) {
        if (candidate.run_id !== runId || candidate.resolution !== null || candidate.event_seqs.length !== 1) throw new Error("Invalid staged opportunity scope");
        const sequence = candidate.event_seqs[0]!;
        const current = source.historySourceRecord(runId, "event", String(sequence), source.historySourceHighwater(runId));
        const pinned = source.historySourceRecord(runId, "event", String(sequence), batch.before.target_through);
        const exact = current ? improvementOpportunityCandidate(source, runId, source.decodeHistorySource("event", current)) : null;
        const available = source.historySourceHighwater(runId);
        const currentExecution = source.historySourceRecord(runId, "execution", candidate.execution_id, available);
        const pinnedExecution = source.historySourceRecord(runId, "execution", candidate.execution_id, batch.before.target_through);
        const skillKey = JSON.stringify([candidate.version.skill_id, candidate.version.version]);
        const currentSkill = source.historySourceRecord(runId, "skill", skillKey, available);
        const pinnedSkill = source.historySourceRecord(runId, "skill", skillKey, batch.before.target_through);
        const patch = batch.patches.find(p => p.type === "put" && p.row.collection === "pending_opportunity" && p.row.key === candidate.opportunity_id);
        if (!exact || canonical(current) !== canonical(pinned) || canonical(currentExecution) !== canonical(pinnedExecution) || canonical(currentSkill) !== canonical(pinnedSkill) ||
          canonical(exact) !== canonical(candidate) || !patch || patch.type !== "put" || canonical(patch.row.value) !== canonical(candidate))
          throw new RuntimeFault("conflict", "History opportunity candidate no longer matches exact current source");
      }
          return source.historySourceHighwater(runId);
        });
        // This bounded metadata CAS is the eligibility linearization point. No reducer,
        // artifact read, derived write, or model work runs under the control write lock.
        this.control.acceptPublication(runId, batchHash, available);
      } else if (accepted.batch_hash !== batchHash) throw new Error("Corrupt projection publication receipt");
    }
    this.projectionDb.transaction(() => {
      const saved = this.historyProjectionCheckpoint(runId);
      if (!saved || canonical(saved) !== canonical(batch.before)) throw new RuntimeFault("conflict", "History projection checkpoint changed before persistence");
      for (const entry of batch.opportunity_bootstrap) {
        const current = this.projectionDb.query<{ seq: number; payload: string }, [string, string]>("SELECT rowid AS seq,payload FROM evidence_objects WHERE run_id=? AND kind='opportunity' AND object_key=?").get(runId, entry.value.opportunity_id);
        if (!current || current.seq !== entry.seq || canonical(JSON.parse(current.payload)) !== canonical(entry.value)) throw new RuntimeFault("conflict", "Opportunity bootstrap changed before persistence");
        this.projectionDb.query(`INSERT INTO history_opportunity_updates(run_id,opportunity_id,generation,skill_id,version,payload)
          SELECT ?1,?2,COALESCE((SELECT generation FROM history_opportunity_visibility WHERE run_id=?1 AND opportunity_id=?2),0),?3,?4,?5
          WHERE NOT EXISTS(SELECT 1 FROM history_opportunity_updates WHERE run_id=?1 AND opportunity_id=?2)`)
          .run(runId, entry.value.opportunity_id, entry.value.version.skill_id, entry.value.version.version, canonical(entry.value));
      }
      for (const patch of batch.patches) {
        if (patch.type === "delete") {
          if (patch.collection === "pending_opportunity") {
            const pending = this.historyProjectionRow(runId, batch.before.revision, patch.collection, patch.key);
            if (!pending || batch.before.phase !== "publish") throw new Error("Opportunity publication requires staged capture");
            const candidate = pending.value as unknown as ImprovementOpportunity;
            this.projectionDb.query(`INSERT OR IGNORE INTO history_opportunity_visibility(run_id,opportunity_id,generation)
              SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM evidence_objects WHERE run_id=?1 AND kind='opportunity' AND object_key=?2)`).run(runId, patch.key, batch.before.generation + 1);
            this.insertOpportunity(candidate);
          }
          this.projectionDb.query("INSERT INTO history_projection_rows(run_id,collection,object_key,revision,owner_id,source_id,order_seq,tag,payload,deleted) VALUES(?,?,?,?,NULL,NULL,0,NULL,NULL,1)").run(runId, patch.collection, patch.key, batch.after.revision);
        } else {
          const row = patch.row;
          this.projectionDb.query("INSERT INTO history_projection_rows(run_id,collection,object_key,revision,owner_id,source_id,order_seq,tag,payload,deleted) VALUES(?,?,?,?,?,?,?,?,?,0)")
            .run(runId, row.collection, row.key, batch.after.revision, row.owner_id, row.source_id, row.order_seq, row.tag, canonical(row.value));
        }
      }
      if (publication) {
        for (const collection of ["pending_opportunity", "dirty_detection", "dirty_outcome", "dirty_objective", "objective_job", "dirty_evidence", "evidence_job"] as const) {
          if (this.historyProjectionCount(runId, batch.after.revision, { collection }) !== 0) throw new Error("Cannot publish a partial history generation");
        }
        this.projectionDb.query("INSERT INTO history_projection_generations(run_id,generation,revision,source_through,metric_change_seq) VALUES(?,?,?,?,?)")
          .run(runId, batch.after.generation, batch.after.revision, batch.after.source_through, batch.after.published_metric_change_seq);
      }
      if (!changed) return;
      const result = this.projectionDb.query("UPDATE history_projection_checkpoints SET payload=? WHERE run_id=? AND payload=?").run(canonical(batch.after), runId, canonical(batch.before));
      if (result.changes !== 1) throw new RuntimeFault("conflict", "History projection checkpoint changed during persistence");
    }).immediate();
  }

  resolveOpportunity(runId: string, id: string, resolution: NonNullable<ImprovementOpportunity["resolution"]>): ImprovementOpportunity {
    const resolved = this.projectionDb.transaction(() => {
      const value = this.opportunity(runId, id);
      if (!value) throw new Error("Improvement opportunity not found");
      if (value.resolution) {
        const { at: _at, ...existing } = value.resolution;
        const { at: _newAt, ...proposed } = resolution;
        if (canonical(existing) !== canonical(proposed)) throw new Error("Improvement resolution is immutable");
        return value;
      }
      value.resolution = resolution;
      this.projectionDb.query("UPDATE evidence_objects SET payload=? WHERE run_id=? AND kind='opportunity' AND object_key=?").run(canonical(value), runId, id);
      const details: Json = { opportunity_id: id, decision: resolution.decision, revision: resolution.revision as unknown as Json, measured: resolution.measured, qualification: resolution.measured ? "measured_not_causally_proven" : "unmeasured_candidate" };
      const payload = canonical({ run_id: runId, type: "learning.resolved", summary: "Recorded model-selected improvement decision", details });
      const receipt = createHash("sha256").update(canonical([this.identity.projection_id, runId, id, "learning.resolved"])).digest("hex");
      this.projectionDb.query("INSERT INTO projection_audit_outbox(receipt_id,run_id,payload,event_seq) VALUES(?,?,?,NULL)").run(receipt, runId, payload);
      return value;
    })();
    this.drainAudit();
    return resolved;
  }

  override close(): void {
    try { this.projectionDb.close(); } finally { super.close(); }
  }
}
