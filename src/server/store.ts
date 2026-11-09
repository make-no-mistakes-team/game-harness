import { Database } from "bun:sqlite";
import { StoreDatabase, STORE_OPPORTUNITY_INDEXES, STORE_SCHEMA_VERSION } from "./store-database.ts";
import { StoreReadQueries, type StoreReadLocation, type PolicyRow, type SkillRow } from "./store-read.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { DeathEpisode, SavedDeathEpisode, ImprovementOpportunity, TraceInput, TraceRecord, WorkingProgram } from "../shared/execution-evidence.ts";
import type { SkillManager } from "./skills.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type {
  ActionView,
  ActivityEvent,
  GameAction,
  Json,
  PolicySpec,
  PolicyView,
  RunView,
  RunControlState,
  ActiveExecutableValidation,
} from "../shared/contracts.ts";
import type {
  SkillExecutionView,
  SkillRef,
  SkillSpec,
  SkillStartRequest,
  SkillView,
} from "../shared/programs.ts";
import { SKILL_API_VERSION } from "../shared/programs.ts";
import type { EffectInvocation, EffectScope } from "../shared/control.ts";
import { effectInvocationSchema, effectScopeSchema } from "../shared/control.ts";
import { skillStartRequestSchema } from "../shared/validation.ts";
import { assertProjectionCheckpoint, assertProjectionRow, projectionRequestFits, HISTORY_PROJECTION_SCHEMA_SQL, PROJECTION_COLLECTIONS, type HistoryProjectionBatch, type ProjectionCheckpoint } from "./history-projection.ts";
import { improvementOpportunityCandidate } from "./program-feedback.ts";
import { HISTORY_SOURCE_KINDS, HISTORY_SOURCE_REGISTRY, HISTORY_SOURCE_SCHEMA_SQL, HISTORY_SOURCE_SCHEMA_VERSION, type HistorySourceKind } from "./history-source.ts";

export type StoredRun = Omit<
  RunView,
  "action" | "policies" | "skills" | "executions" | "operator"
> & {
  baseline: Json;
  control?: RunControlState;
};
export interface StoredAction {
  request: GameAction;
  fingerprint: string;
  view: ActionView;
}

function canonical(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Non-finite request value");
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    return item;
  });
  if (text === undefined) throw new Error("Request must be JSON");
  return text;
}

const terminalExecutions = new Set<SkillExecutionView["status"]>([
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
  "unknown",
]);

export class Store extends StoreReadQueries {
  private readonly db: StoreDatabase;
  private readonly artifactDir: string;
  private readonly listeners = new Set<(event: ActivityEvent) => void>();
  private readonly traceObservers = new Set<(input: TraceInput) => void>();
  private readonly historyListeners = new Set<(runId: string) => void>();
  private readonly sourcePreparations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const artifactDir = path.resolve(dataDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const filename = path.resolve(dataDir, "runs.sqlite");
    const database = new StoreDatabase(new Database(filename, { create: true, strict: true }));
    super(database, artifactDir);
    this.artifactDir = artifactDir;
    this.db = database;
    chmodSync(filename, 0o600);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const version =
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0;
    if (version > STORE_SCHEMA_VERSION)
      throw new Error(
        "The run database was created by a newer GameHarness version",
      );
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT NOT NULL CHECK(json_valid(details))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, event_seq);
        CREATE INDEX IF NOT EXISTS events_run_type_seq ON events(run_id, type, event_seq);
        CREATE TABLE IF NOT EXISTS actions (
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
          action_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          request TEXT NOT NULL CHECK(json_valid(request)),
          view TEXT NOT NULL CHECK(json_valid(view)),
          PRIMARY KEY(run_id, action_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS policies (
          policy_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version > 0),
          name TEXT NOT NULL,
          hash TEXT NOT NULL,
          metadata TEXT NOT NULL CHECK(json_valid(metadata)),
          PRIMARY KEY(policy_id, version),
          UNIQUE(run_id, name, version)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS policies_run ON policies(run_id, name, version);
        CREATE TABLE IF NOT EXISTS skills (
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
          skill_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          name TEXT NOT NULL,
          hash TEXT NOT NULL,
          metadata TEXT NOT NULL CHECK(json_valid(metadata)),
          PRIMARY KEY(run_id, skill_id, version),
          UNIQUE(run_id, name, version)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS skills_run ON skills(run_id, name, version);
        CREATE INDEX IF NOT EXISTS skills_ref ON skills(skill_id, version);
        CREATE TABLE IF NOT EXISTS skill_executions (
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
          execution_id TEXT NOT NULL,
          admission_ordinal INTEGER NOT NULL CHECK(admission_ordinal > 0),
          start_key TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          parent_execution_id TEXT,
          root_execution_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          request TEXT NOT NULL CHECK(json_valid(request)),
          view TEXT NOT NULL CHECK(json_valid(view)),
          PRIMARY KEY(run_id, execution_id),
          UNIQUE(run_id, start_key),
          FOREIGN KEY(run_id, skill_id, version) REFERENCES skills(run_id, skill_id, version),
          FOREIGN KEY(run_id, parent_execution_id) REFERENCES skill_executions(run_id, execution_id),
          FOREIGN KEY(run_id, root_execution_id) REFERENCES skill_executions(run_id, execution_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS skill_executions_parent ON skill_executions(run_id, parent_execution_id);
        CREATE INDEX IF NOT EXISTS skill_executions_root ON skill_executions(run_id, root_execution_id);
        CREATE INDEX IF NOT EXISTS skill_executions_measured ON skill_executions(run_id,skill_id,version)
          WHERE json_extract(view,'$.started_at') IS NOT NULL AND json_extract(view,'$.status') IN ('succeeded','blocked','failed','unknown','cancelled');
        CREATE TABLE IF NOT EXISTS store_metadata (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL CHECK(value >= 0)
        ) STRICT;
        INSERT OR IGNORE INTO store_metadata(key,value)
          SELECT 'game_epoch',COALESCE(MAX(json_extract(payload,'$.epoch')),0)
          FROM runs WHERE json_type(payload,'$.epoch')='integer';
        CREATE TABLE IF NOT EXISTS execution_trace (
          trace_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          bytes INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS trace_run_seq ON execution_trace(run_id,trace_seq);
        CREATE TABLE IF NOT EXISTS trace_budgets (
          run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
          recorded INTEGER NOT NULL DEFAULT 0,
          bytes INTEGER NOT NULL DEFAULT 0,
          omitted_records INTEGER NOT NULL DEFAULT 0,
          omitted_bytes INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS evidence_objects (
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          kind TEXT NOT NULL,
          object_key TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          PRIMARY KEY(run_id,kind,object_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS working_programs (
          session_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          PRIMARY KEY(session_id,model_id,skill_id,version)
        ) STRICT;
      `);
      const executionColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(skill_executions)").all();
      if (!executionColumns.some((column) => column.name === "admission_ordinal")) {
        this.db.exec("ALTER TABLE skill_executions ADD COLUMN admission_ordinal INTEGER CHECK(admission_ordinal > 0)");
        this.db.exec("UPDATE skill_executions SET admission_ordinal=rowid");
      }
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_executions_ordinal ON skill_executions(admission_ordinal)");
      for (const index of STORE_OPPORTUNITY_INDEXES) this.db.exec(index.sql);
      if (version < 2) this.migrateLegacyRows();
      if (version < HISTORY_SOURCE_SCHEMA_VERSION) {
        this.db.exec(HISTORY_SOURCE_SCHEMA_SQL);
        const registerBootstrap = this.db.query(
          "INSERT INTO history_source_bootstrap(kind,through_ordinal,after_ordinal) VALUES(?,?,0)",
        );
        for (const kind of HISTORY_SOURCE_KINDS) {
          const source = HISTORY_SOURCE_REGISTRY[kind];
          const through = this.db.query<{ ordinal: number }, []>(
            `SELECT COALESCE(MAX(rowid),0) AS ordinal FROM ${source.table}`,
          ).get()!.ordinal;
          if (!Number.isSafeInteger(through) || through < 0)
            throw new Error(`Invalid history source bootstrap highwater for ${kind}`);
          registerBootstrap.run(kind, through);
        }
      }
      this.db.exec(HISTORY_PROJECTION_SCHEMA_SQL);
      for (const row of this.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'improvement_%'").all()) {
        this.db.exec(`DROP TRIGGER "${row.name.replace(/"/g, '""')}"`);
      }
      this.db.exec("DROP TABLE IF EXISTS improvement_work; DROP TABLE IF EXISTS improvement_checkpoints; DROP INDEX IF EXISTS events_improvement_run_seq; DROP INDEX IF EXISTS events_improvement_execution_seq;");
      this.db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
    })();
  }

  readLocation(): StoreReadLocation {
    return { database: path.join(path.dirname(this.artifactDir), "runs.sqlite"), artifacts: this.artifactDir };
  }

  /** Register only bounded baseline keys; bodies remain backed by canonical source rows. */
  advanceHistorySourceBootstrap(limit = 128): { complete: boolean; processed: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("History source bootstrap limit must be an integer from 1 to 128");
    return this.db.transaction(() => {
      const progress = this.db.query<{
        kind: HistorySourceKind;
        through_ordinal: number;
        after_ordinal: number;
      }, []>(
        "SELECT kind,through_ordinal,after_ordinal FROM history_source_bootstrap",
      ).all();
      if (progress.length !== HISTORY_SOURCE_KINDS.length ||
        new Set(progress.map((entry) => entry.kind)).size !== HISTORY_SOURCE_KINDS.length ||
        progress.some((entry) =>
          !Object.hasOwn(HISTORY_SOURCE_REGISTRY, entry.kind) ||
          !Number.isSafeInteger(entry.through_ordinal) || entry.through_ordinal < 0 ||
          !Number.isSafeInteger(entry.after_ordinal) || entry.after_ordinal < 0 ||
          entry.after_ordinal > entry.through_ordinal))
        throw new Error("Invalid history source bootstrap progress");
      const register = this.db.query(
        `INSERT INTO history_source_keys(run_id,kind,source_key,created_seq)
          SELECT ?1,?2,?3,0
          WHERE NOT EXISTS(SELECT 1 FROM history_source_keys WHERE run_id=?1 AND kind=?2 AND source_key=?3)`,
      );
      const advance = this.db.query(
        "UPDATE history_source_bootstrap SET after_ordinal=? WHERE kind=?",
      );
      let processed = 0;
      for (const kind of HISTORY_SOURCE_KINDS) {
        const entry = progress.find((row) => row.kind === kind)!;
        if (entry.after_ordinal === entry.through_ordinal || processed === limit) continue;
        const source = HISTORY_SOURCE_REGISTRY[kind];
        const rows = this.db.query<{
          ordinal: number;
          run_id: string | null;
          source_key: string;
        }, [number, number, number]>(
          `SELECT rowid AS ordinal,${source.runSql} AS run_id,${source.keySql} AS source_key FROM ${source.table}
            WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`,
        ).all(entry.after_ordinal, entry.through_ordinal, limit - processed);
        for (const row of rows) {
          if (!Number.isSafeInteger(row.ordinal) ||
            row.ordinal <= entry.after_ordinal || row.ordinal > entry.through_ordinal)
            throw new Error("Invalid history source bootstrap row ordinal");
          if (row.run_id !== null) register.run(row.run_id, kind, row.source_key);
          entry.after_ordinal = row.ordinal;
          processed++;
        }
        const remaining = this.db.query<{ ordinal: number }, [number, number]>(
          `SELECT rowid AS ordinal FROM ${source.table} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 1`,
        ).get(entry.after_ordinal, entry.through_ordinal);
        if (!remaining) entry.after_ordinal = entry.through_ordinal;
        advance.run(entry.after_ordinal, kind);
      }
      return {
        complete: progress.every((entry) => entry.after_ordinal === entry.through_ordinal),
        processed,
      };
    })();
  }

  nextGameEpoch(): number {
    return this.db.transaction(() => {
      const row = this.db
        .query<{ value: number }, []>(
          "UPDATE store_metadata SET value=value+1 WHERE key='game_epoch' AND value<9007199254740991 RETURNING value",
        )
        .get();
      if (!row)
        throw new Error("Persistent game epoch is unavailable or exhausted");
      return row.value;
    })();
  }

  private migrateLegacyRows(): void {
    const actions = this.db
      .query<{ run_id: string; action_id: string; view: string }, []>(
        "SELECT run_id,action_id,view FROM actions",
      )
      .all();
    const saveAction = this.db.query(
      "UPDATE actions SET view=? WHERE run_id=? AND action_id=?",
    );
    for (const row of actions) {
      const view = JSON.parse(row.view) as ActionView;
      view.execution_id ??= null;
      saveAction.run(JSON.stringify(view), row.run_id, row.action_id);
    }
    const policies = this.db
      .query<PolicyRow, []>(
        "SELECT policy_id,run_id,version,name,hash,metadata FROM policies",
      )
      .all();
    const savePolicy = this.db.query(
      "UPDATE policies SET metadata=? WHERE run_id=? AND policy_id=? AND version=?",
    );
    for (const row of policies) {
      const metadata = JSON.parse(row.metadata) as Omit<PolicyView, "source">;
      metadata.backend ??= "javascript";
      metadata.choices ??= null;
      savePolicy.run(
        JSON.stringify(metadata),
        row.run_id,
        row.policy_id,
        row.version,
      );
    }
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Trusted authorized trace tap BEFORE ordinary diagnostic truncation.
   * Observers must only enqueue bounded private evidence; never mutate authority. */
  subscribeTraceEvidence(listener: (input: TraceInput) => void): () => void {
    this.traceObservers.add(listener);
    return () => this.traceObservers.delete(listener);
  }

  subscribeHistoryChanges(listener: (runId: string) => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  private notifyHistory(runId: string): void {
    this.db.afterCommit(() => {
      for (const listener of this.historyListeners) {
        try { listener(runId); } catch { /* Durable source journal, not an observer, owns progress. */ }
      }
    });
  }

  private append(
    runId: string | null,
    type: string,
    summary: string,
    details: Json,
  ): ActivityEvent {
    const at = new Date().toISOString();
    const result = this.db
      .query(
        "INSERT INTO events(run_id,at,type,summary,details) VALUES(?,?,?,?,?)",
      )
      .run(runId, at, type, summary, JSON.stringify(details));
    return {
      event_seq: Number(result.lastInsertRowid),
      run_id: runId,
      at,
      type,
      summary,
      details,
    };
  }

  private notify(event: ActivityEvent): void {
    if (event.run_id !== null) this.notifyHistory(event.run_id);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* A disconnected observer does not undo durable evidence. */
      }
    }
  }

  event(
    runId: string | null,
    type: string,
    summary: string,
    details: Json = null,
  ): ActivityEvent {
    const event = this.append(runId, type, summary, details);
    this.notify(event);
    return event;
  }

  appendEvents(runId: string | null, entries: readonly { type: string; summary: string; details: Json }[]): ActivityEvent[] {
    const events = this.db.transaction(() =>
      entries.map(entry => this.append(runId, entry.type, entry.summary, entry.details)),
    )();
    for (const event of events) this.notify(event);
    return events;
  }

  saveRun(run: StoredRun, summary?: string): void {
    let event: ActivityEvent | undefined;
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO runs(run_id,created_at,payload) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(
          run.run_id,
          run.started_at ?? new Date().toISOString(),
          JSON.stringify(this.normalizeRun(JSON.stringify(run))),
        );
      if (summary)
        event = this.append(run.run_id, "run.state", summary, {
          status: run.status,
          epoch: run.epoch,
        });
    })();
    if (event) this.notify(event);
    else this.notifyHistory(run.run_id);
  }

  admitAction(
    runId: string,
    id: string,
    request: GameAction,
    origin: ActionView["origin"],
    executionId: string | null = null,
    authority: { scope: EffectScope; invocation: EffectInvocation; compatibility_hash: string },
  ): { action: StoredAction; created: boolean } {
    const scope = effectScopeSchema.parse(authority.scope), invocation = effectInvocationSchema.parse(authority.invocation);
    const run = this.getRun(runId);
    if (!run || run.status !== "running" || scope.run_id !== runId || scope.world_id !== run.world_id || scope.epoch !== run.epoch ||
      scope.session_id !== run.session_id || scope.native_boot_id !== run.native_boot_id || scope.life_id !== run.life_id ||
      scope.space_epoch !== run.space_epoch || authority.compatibility_hash !== run.compatibility_hash ||
      invocation.execution_id !== scope.execution_id || invocation.source_hash !== scope.source_hash || invocation.kind !== origin ||
      executionId !== invocation.execution_id) throw new RuntimeFault("invalid_authority", "Action admission requires the current host-created invocation scope");
    const requestText = JSON.stringify(request);
    const fingerprint = createHash("sha256").update(canonical({ request, authority })).digest("hex");
    let event: ActivityEvent | undefined;
    const result = this.db.transaction(() => {
      const existing = this.getAction(runId, id);
      if (existing) {
        if (existing.view.scope === null) throw new Error("Historical action identities are inspect-only");
        if (
          existing.fingerprint !== fingerprint ||
          existing.view.origin !== origin ||
          existing.view.execution_id !== executionId
        )
          throw new Error("Action ID already exists with different content");
        return { action: existing, created: false };
      }
      if (origin === "skill") {
        if (
          !executionId ||
          !this.skillExecution(runId, { execution_id: executionId })
        )
          throw new Error("Skill action requires an execution in this run");
      }
      const view: ActionView = {
        action_id: id,
        kind: request.kind,
        status: "accepted",
        origin,
        execution_id: executionId,
        session_id: this.getRun(runId)?.session_id ?? null,
        life_id: this.getRun(runId)?.life_id ?? null,
        scope,
        invocation,
        compatibility_hash: authority.compatibility_hash,
        summary: `${request.kind} accepted`,
        started_at: null,
        ended_at: null,
        result: null,
      };
      this.db
        .query(
          "INSERT INTO actions(run_id,action_id,fingerprint,request,view) VALUES(?,?,?,?,?)",
        )
        .run(runId, id, fingerprint, requestText, JSON.stringify(view));
      event = this.append(runId, "action.accepted", view.summary, {
        action_id: id,
        origin,
        execution_id: executionId,
        request: request as unknown as Json,
      });
      return { action: { request, fingerprint, view }, created: true };
    })();
    if (event) this.notify(event);
    return result;
  }

  saveAction(runId: string, view: ActionView): void {
    let event: ActivityEvent | undefined;
    this.db.transaction(() => {
      this.db
        .query("UPDATE actions SET view=? WHERE run_id=? AND action_id=?")
        .run(JSON.stringify(view), runId, view.action_id);
      event = this.append(runId, `action.${view.status}`, view.summary, {
        action_id: view.action_id,
        origin: view.origin,
        execution_id: view.execution_id,
        result: view.result as unknown as Json,
      });
    })();
    if (event) this.notify(event);
  }

  closeUnfinishedActions(runId: string): void {
    const rows = this.db
      .query<{ view: string }, [string]>(
        "SELECT view FROM actions WHERE run_id=?",
      )
      .all(runId);
    for (const row of rows) {
      const view = this.readActionView(row.view);
      if (!["accepted", "running", "cancel_requested"].includes(view.status))
        continue;
      view.status = view.status === "accepted" ? "cancelled" : "unknown";
      view.ended_at = new Date().toISOString();
      view.summary = "Previous process ended; no action is replayed";
      view.result = {
        status: view.status,
        summary: view.summary,
        evidence: null,
      };
      this.saveAction(runId, view);
    }
  }

  private async saveSource(source: string): Promise<string> {
    this.assertOpen();
    const hash = createHash("sha256").update(source).digest("hex");
    const pending = this.sourcePreparations.get(hash);
    if (pending) {
      await pending;
      return hash;
    }
    const preparation = this.prepareSource(hash, source);
    this.sourcePreparations.set(hash, preparation);
    try {
      await preparation;
      return hash;
    } finally {
      this.sourcePreparations.delete(hash);
    }
  }

  private async prepareSource(hash: string, source: string): Promise<void> {
    const filename = path.join(this.artifactDir, `${hash}.js`);
    let existing: Buffer | undefined;
    try {
      existing = await readFile(filename);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (createHash("sha256").update(existing).digest("hex") !== hash)
        throw new Error("Stored artifact integrity check failed");
      // A concurrent Store may have renamed these bytes but not yet synced the directory.
      await this.syncArtifactDirectory();
      return;
    }
    const temporary = path.join(this.artifactDir, `${hash}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        await file.writeFile(source, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, filename);
      await this.syncArtifactDirectory();
    } finally {
      if (temporaryCreated) {
        await unlink(temporary).catch((error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        });
      }
    }
  }

  private async syncArtifactDirectory(): Promise<void> {
    const directory = await open(this.artifactDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Store is closed");
  }

  async registerPolicy(
    runId: string,
    spec: PolicySpec,
    authoringTurn: number,
    validation: ActiveExecutableValidation,
    beforeCommit?: () => void,
    registration?: { call_id: string; input: Json },
  ): Promise<PolicyView> {
    spec = structuredClone(spec);
    validation = structuredClone(validation);
    if (registration) registration = structuredClone(registration);
    const hash = await this.saveSource(spec.source);
    this.assertOpen();
    beforeCommit?.();
    this.assertOpen();
    let event: ActivityEvent | undefined;
    const policy = this.db.transaction(() => {
      if (registration) {
        const prior = this.completedToolCall(runId, registration.call_id, registration.input);
        if (prior !== null) {
          const ref = prior as unknown as { policy_id: string; version: number };
          const row = this.db.query<PolicyRow, [string, string, number]>(
            "SELECT policy_id,run_id,version,name,hash,metadata FROM policies WHERE run_id=? AND policy_id=? AND version=?",
          ).get(runId, ref.policy_id, ref.version);
          if (!row) throw new Error("Pinned policy registration is unavailable");
          return this.hydratePolicy(row);
        }
      }
      const pin = (view: PolicyView) => {
        if (registration) this.completeToolCall(runId, registration.call_id, registration.input,
          { policy_id: view.policy_id, version: view.version });
        return view;
      };
      const previous = this.db
        .query<PolicyRow, [string, string]>(
          "SELECT policy_id,run_id,version,name,hash,metadata FROM policies WHERE run_id=? AND name=? ORDER BY version DESC LIMIT 1",
        )
        .get(runId, spec.name);
      if (previous && previous.hash === hash) {
        const previousView = this.hydratePolicy(previous);
        if (
          JSON.stringify(previousView.card) === JSON.stringify(spec.card) &&
          previousView.backend === spec.backend &&
          canonical(previousView.choices) === canonical(spec.choices) &&
          previousView.priority === spec.priority &&
          previousView.interval_ms === spec.interval_ms &&
          previousView.validation?.fingerprint === validation.fingerprint
        )
          return pin(previousView);
      }
      const view: PolicyView = {
        policy_id: previous?.policy_id ?? randomUUID(),
        version: (previous?.version ?? 0) + 1,
        name: spec.name,
        hash,
        state: "draft",
        source: spec.source,
        validation,
        backend: spec.backend,
        choices: spec.choices,
        card: spec.card,
        priority: spec.priority,
        interval_ms: spec.interval_ms,
        evaluations: 0,
        effects: 0,
        last_error: null,
      };
      const { source: _source, ...metadata } = view;
      this.db
        .query(
          "INSERT INTO policies(policy_id,run_id,version,name,hash,metadata) VALUES(?,?,?,?,?,?)",
        )
        .run(
          view.policy_id,
          runId,
          view.version,
          view.name,
          hash,
          JSON.stringify(metadata),
        );
      event = this.append(
        runId,
        "policy.authored",
        `Model authored ${view.name} v${view.version}`,
        {
          policy_id: view.policy_id,
          version: view.version,
          hash,
          authoring_turn: authoringTurn,
          parent_version: previous?.version ?? null,
          card: view.card as unknown as Json,
        },
      );
      return pin(view);
    })();
    if (event) this.notify(event);
    return policy;
  }

  savePolicy(runId: string, view: PolicyView, summary?: string): void {
    const { source: _source, ...metadata } = view;
    let event: ActivityEvent | undefined;
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE policies SET metadata=? WHERE run_id=? AND policy_id=? AND version=?",
        )
        .run(JSON.stringify(metadata), runId, view.policy_id, view.version);
      if (summary)
        event = this.append(runId, "policy.state", summary, {
          policy_id: view.policy_id,
          version: view.version,
          state: view.state,
          evaluations: view.evaluations,
          effects: view.effects,
          error: view.last_error,
        });
    })();
    if (event) this.notify(event);
  }

  async registerSkill(
    runId: string,
    spec: SkillSpec & { validation: SkillView["validation"] },
    registration?: { call_id: string; input: Json },
    beforeCommit?: () => void,
  ): Promise<SkillView> {
    spec = structuredClone(spec);
    if (registration) registration = structuredClone(registration);
    const hash = await this.saveSource(spec.source);
    this.assertOpen();
    beforeCommit?.();
    this.assertOpen();
    let event: ActivityEvent | undefined;
    const view = this.db.transaction(() => {
      if (registration) {
        const previous = this.completedToolCall(runId, registration.call_id, registration.input);
        if (previous !== null) return this.skill(runId, previous as unknown as SkillRef);
      }
      if (!this.getRun(runId)) throw new Error("Run not found");
      for (const dependency of spec.dependencies) this.skill(runId, dependency);
      const previous = this.db
        .query<SkillRow, [string, string]>(
          "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? AND name=? ORDER BY version DESC LIMIT 1",
        )
        .get(runId, spec.name);
      const result: SkillView = {
        skill_id: previous?.skill_id ?? randomUUID(),
        version: previous
          ? this.db
              .query<{ version: number }, [string]>(
                "SELECT MAX(version) AS version FROM skills WHERE skill_id=?",
              )
              .get(previous.skill_id)!.version + 1
          : 1,
        parent_version: previous?.version ?? null,
        entry: spec.entry,
        name: spec.name,
        source: spec.source,
        hash,
        card: spec.card,
        dependencies: spec.dependencies,
        validation: spec.validation,
        state: "validated",
        created_at: new Date().toISOString(),
      };
      const { source: _source, ...metadata } = result;
      this.db
        .query(
          "INSERT INTO skills(run_id,skill_id,version,name,hash,metadata) VALUES(?,?,?,?,?,?)",
        )
        .run(
          runId,
          result.skill_id,
          result.version,
          result.name,
          hash,
          JSON.stringify(metadata),
        );
      if (registration) this.completeToolCall(runId, registration.call_id, registration.input,
        { skill_id: result.skill_id, version: result.version });
      event = this.append(
        runId,
        "skill.authored",
        `Authored ${result.name} v${result.version}`,
        {
          skill_id: result.skill_id,
          version: result.version,
          hash,
          parent_version: result.parent_version,
          card: result.card as unknown as Json,
          dependencies: result.dependencies as unknown as Json,
          validation: result.validation as unknown as Json,
        },
      );
      return result;
    })();
    if (event) this.notify(event);
    return view;
  }

  async importSkill(runId: string, view: SkillView, beforeCommit?: () => void): Promise<SkillView> {
    view = structuredClone(view);
    const hash = await this.saveSource(view.source);
    if (hash !== view.hash)
      throw new Error("Imported skill artifact hash does not match");
    if (view.state !== "validated")
      throw new Error("Imported skill must be freshly validated");
    this.assertOpen();
    beforeCommit?.();
    this.assertOpen();
    let event: ActivityEvent | undefined;
    const imported = this.db.transaction(() => {
      if (!this.getRun(runId)) throw new Error("Run not found");
      for (const dependency of view.dependencies) this.skill(runId, dependency);
      const copies = this.db
        .query<SkillRow, [string, number]>(
          "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE skill_id=? AND version=?",
        )
        .all(view.skill_id, view.version);
      const fingerprint = canonical(view);
      let scoped: SkillView | null = null;
      for (const copy of copies) {
        const existing = this.hydrateSkill(copy);
        if (canonical(existing) !== fingerprint)
          throw new Error(
            "Imported skill reference conflicts with immutable content",
          );
        if (copy.run_id === runId) scoped = existing;
      }
      if (scoped) return scoped;
      const sameName = this.db
        .query<{ skill_id: string }, [string, string]>(
          "SELECT skill_id FROM skills WHERE run_id=? AND name=? LIMIT 1",
        )
        .get(runId, view.name);
      if (sameName && sameName.skill_id !== view.skill_id)
        throw new Error(
          "Imported skill name belongs to a different skill in this run",
        );
      const { source: _source, ...metadata } = view;
      this.db
        .query(
          "INSERT INTO skills(run_id,skill_id,version,name,hash,metadata) VALUES(?,?,?,?,?,?)",
        )
        .run(
          runId,
          view.skill_id,
          view.version,
          view.name,
          hash,
          JSON.stringify(metadata),
        );
      event = this.append(
        runId,
        "skill.imported",
        `Imported ${view.name} v${view.version}`,
        {
          skill_id: view.skill_id,
          version: view.version,
          hash,
          dependencies: view.dependencies as unknown as Json,
          validation: view.validation as unknown as Json,
        },
      );
      return this.skill(runId, view);
    })();
    if (event) this.notify(event);
    return imported;
  }

  private toolCallRecord(runId: string, callId: string, kind: string): Json | null {
    const row = this.db.query<{ payload: string }, [string, string, string]>(
      "SELECT payload FROM evidence_objects WHERE run_id=? AND kind=? AND object_key=?",
    ).get(runId, kind, callId);
    return row ? JSON.parse(row.payload) as Json : null;
  }

  private assertToolCallInput(runId: string, callId: string, input: Json, capture: boolean): void {
    const hash = createHash("sha256").update(canonical(input)).digest("hex");
    const previous = this.toolCallRecord(runId, callId, "tool_identity");
    if (previous !== null && previous !== hash)
      throw new RuntimeFault("conflict", "A trusted tool-call identity cannot be reused for a different decision");
    if (capture && previous === null) this.saveEvidenceObject(runId, "tool_identity", callId, hash);
  }

  bindToolCall(runId: string, callId: string, input: Json, create: () => Json): Json {
    return this.db.transaction(() => {
      this.assertToolCallInput(runId, callId, input, true);
      const previous = this.lookupToolCallBinding(runId, callId, input);
      if (previous.found) return previous.value;
      const value = create();
      this.db.query("INSERT INTO evidence_objects(run_id,kind,object_key,payload) VALUES(?,'tool_binding',?,?)")
        .run(runId, callId, canonical(value));
      return value;
    })();
  }

  lookupToolCallBinding(runId: string, callId: string, input: Json): { found: false } | { found: true; value: Json } {
    this.assertToolCallInput(runId, callId, input, false);
    const row = this.db.query<{ payload: string }, [string, string]>(
      "SELECT payload FROM evidence_objects WHERE run_id=? AND kind='tool_binding' AND object_key=?",
    ).get(runId, callId);
    return row ? { found: true, value: JSON.parse(row.payload) as Json } : { found: false };
  }

  completedToolCall(runId: string, callId: string, input: Json): Json | null {
    this.assertToolCallInput(runId, callId, input, false);
    return this.toolCallRecord(runId, callId, "tool_result");
  }

  completeToolCall(runId: string, callId: string, input: Json, result: Json): void {
    this.db.transaction(() => {
      this.assertToolCallInput(runId, callId, input, true);
      const previous = this.toolCallRecord(runId, callId, "tool_result");
      if (previous !== null && canonical(previous) !== canonical(result))
        throw new RuntimeFault("conflict", "A completed tool call has an immutable result");
      this.saveEvidenceObject(runId, "tool_result", callId, result);
    })();
  }

  admitSkill(
    runId: string,
    request: SkillStartRequest,
    lineage?: { parent_execution_id: string; root_execution_id: string },
    originalDeadlineAt?: string,
  ): { view: SkillExecutionView; created: boolean } {
    request = skillStartRequestSchema.parse(request);
    const requestText = canonical({
      run_id: runId,
      request,
      lineage: lineage ?? null,
    });
    const fingerprint = createHash("sha256").update(requestText).digest("hex");
    let event: ActivityEvent | undefined;
    const admitted = this.db.transaction(() => {
      // A committed key is authoritative even after epoch, state or permissions change.
      const existing = this.db
        .query<{ fingerprint: string; view: string }, [string, string]>(
          "SELECT fingerprint,view FROM skill_executions WHERE run_id=? AND start_key=?",
        )
        .get(runId, request.start_key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error(
            "Skill start key already exists with different content",
          );
        return {
          view: this.readExecutionView(existing.view),
          created: false,
        };
      }
      const run = this.getRun(runId);
      if (!run) throw new Error("Run not found");
      if (run.epoch !== request.epoch)
        throw new Error("Skill start epoch is stale");
      if (
        !request.session_id ||
        !Number.isSafeInteger(request.life_id) ||
        request.life_id < 0 ||
        run.session_id !== request.session_id ||
        run.life_id !== request.life_id
      )
        throw new Error("Skill start session or life is stale");
      if (run.status !== "running")
        throw new Error("Run is not accepting skill starts");
      if (run.native_boot_id !== request.native_boot_id || run.space_epoch !== request.space_epoch ||
        run.compatibility_hash !== request.compatibility_hash || !request.native_boot_id || !request.compatibility_hash ||
        !Number.isSafeInteger(request.run_generation) || request.run_generation < 0)
        throw new Error("Skill start does not match negotiated boot/space/profile authority");
      const skill = this.skill(runId, request);
      if (skill.state !== "validated")
        throw new Error("Skill is not validated");
      if (skill.entry !== request.entry || (request.entry === "step" && lineage))
        throw new Error("Selected entry cannot acquire this playing execution or child lineage");
      if (skill.validation.runtime_version !== 5 || skill.validation.api_version !== 5 || skill.validation.validator_version !== 5 ||
        skill.validation.compatibility_hash !== request.compatibility_hash)
        throw new Error("Historical or incompatible executable validation is read-only");
      const id = randomUUID();
      let root: SkillExecutionView | null = null;
      if (lineage) {
        const parent = this.skillExecution(runId, {
          execution_id: lineage.parent_execution_id,
        });
        root = this.skillExecution(runId, {
          execution_id: lineage.root_execution_id,
        });
        const sessionRoot = root?.entry === "step" && root.session !== undefined;
        if (
          !parent ||
          !root ||
          request.entry !== "run" ||
          (parent.entry !== "run" && !(parent.entry === "step" && parent.session)) ||
          (root.entry !== "run" && !sessionRoot) ||
          parent.root_execution_id !== root.execution_id ||
          root.root_execution_id !== root.execution_id ||
          root.parent_execution_id !== null ||
          parent.epoch !== request.epoch ||
          root.epoch !== request.epoch ||
          parent.session_id !== request.session_id ||
          root.session_id !== request.session_id ||
          !["accepted", "running"].includes(parent.status) ||
          !["accepted", "running"].includes(root.status)
        )
          throw new Error("Invalid or closed skill execution lineage");
        let depth = 1;
        let ancestor = parent;
        while (ancestor.parent_execution_id) {
          const next = this.skillExecution(runId, {
            execution_id: ancestor.parent_execution_id,
          });
          if (!next || next.entry !== "run" || next.root_execution_id !== root.execution_id)
            if (!(next?.entry === "step" && next.session && next.execution_id === root.execution_id))
              throw new Error("Invalid skill execution ancestry");
          if (!next) throw new Error("Invalid skill execution ancestry");
          ancestor = next;
          depth++;
          if (depth >= (root.entry === "run" ? root.limits.max_depth : root.entry === "step" ? root.session!.max_depth : 8))
            throw new Error("Skill execution depth limit reached");
        }
        if (depth >= (root.entry === "run" ? root.limits.max_depth : root.entry === "step" ? root.session!.max_depth : 8))
          throw new Error("Skill execution depth limit reached");
        if (Date.parse(root.deadline_at) <= Date.now())
          throw new Error("Skill execution deadline reached");
      }
      const view: SkillExecutionView = {
        skill_id: request.skill_id,
        version: request.version,
        execution_id: id,
        run_id: runId,
        world_id: run.world_id,
        start_key: request.start_key,
        parent_execution_id: lineage?.parent_execution_id ?? null,
        root_execution_id: root?.execution_id ?? id,
        epoch: request.epoch,
        session_id: request.session_id,
        life_id: request.life_id,
        native_boot_id: request.native_boot_id,
        run_generation: request.run_generation,
        space_epoch: request.space_epoch,
        source_hash: skill.hash,
        compatibility_hash: request.compatibility_hash,
        args: request.args,
        ...(request.entry === "step"
          ? { entry: "step" as const, limits: request.limits, initial_state: request.initial_state, resident: null,
              ...(request.session ? { session: request.session } : {}) }
          : { entry: "run" as const, limits: root?.entry === "run" ? root.limits : request.limits }),
        status: "accepted",
        started_at: null,
        ended_at: null,
        deadline_at:
          new Date(Math.min(root ? Date.parse(root.deadline_at) : Infinity,
            originalDeadlineAt === undefined ? Infinity : Date.parse(originalDeadlineAt),
            Date.now() + request.limits.duration_ms)).toISOString(),
        actions: 0,
        calls: 0,
        result: null,
        error: null,
      };
      const ordinal = this.db.query<{ value: number }, []>(
        "SELECT COALESCE(MAX(admission_ordinal),0)+1 AS value FROM skill_executions",
      ).get()!.value;
      this.db
        .query(
          "INSERT INTO skill_executions(run_id,execution_id,admission_ordinal,start_key,skill_id,version,parent_execution_id,root_execution_id,fingerprint,request,view) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          runId,
          id,
          ordinal,
          request.start_key,
          request.skill_id,
          request.version,
          view.parent_execution_id,
          view.root_execution_id,
          fingerprint,
          requestText,
          JSON.stringify(view),
        );
      event = this.append(
        runId,
        "skill.accepted",
        `Accepted ${skill.name} v${skill.version}`,
        {
          execution_id: id,
          start_key: view.start_key,
          skill_id: view.skill_id,
          version: view.version,
          parent_execution_id: view.parent_execution_id,
          root_execution_id: view.root_execution_id,
          epoch: view.epoch,
          session_id: view.session_id,
          life_id: view.life_id,
          deadline_at: view.deadline_at,
        },
      );
      return { view, created: true };
    })();
    if (event) this.notify(event);
    return admitted;
  }

  updateSkillExecution(
    view: SkillExecutionView,
    eventType: string,
    summary: string,
    details: Json = null,
  ): void {
    let event: ActivityEvent | undefined;
    this.db.transaction(() => {
      const previous = this.skillExecution(view.run_id, {
        execution_id: view.execution_id,
      });
      if (!previous) throw new Error("Skill execution not found in this run");
      const identity = (value: SkillExecutionView) => ({
        entry: value.entry,
        initial_state: value.entry === "step" ? value.initial_state : null,
        session: value.entry === "step" ? value.session ?? null : null,
        skill_id: value.skill_id,
        version: value.version,
        run_id: value.run_id,
        execution_id: value.execution_id,
        start_key: value.start_key,
        parent_execution_id: value.parent_execution_id,
        root_execution_id: value.root_execution_id,
        epoch: value.epoch,
        session_id: value.session_id,
        life_id: value.life_id,
        native_boot_id: value.native_boot_id,
        run_generation: value.run_generation,
        space_epoch: value.space_epoch,
        source_hash: value.source_hash,
        compatibility_hash: value.compatibility_hash,
        args: value.args,
        limits: value.limits,
        deadline_at: value.deadline_at,
      });
      if (canonical(identity(previous)) !== canonical(identity(view)))
        throw new Error(
          "Skill execution identity, limits and deadline are immutable",
        );
      if (
        !Number.isInteger(view.actions) ||
        view.actions < previous.actions ||
        !Number.isInteger(view.calls) ||
        view.calls < previous.calls
      )
        throw new Error("Skill execution counters cannot decrease");
      if (
        terminalExecutions.has(previous.status) &&
        canonical(previous) !== canonical(view)
      )
        throw new Error("Terminal skill execution is immutable");
      if (
        (previous.status !== "accepted" && view.status === "accepted") ||
        (previous.status === "cancel_requested" && view.status === "running") ||
        (previous.started_at !== null &&
          previous.started_at !== view.started_at) ||
        (view.status === "running" && view.started_at === null) ||
        (view.status === "accepted" && view.started_at !== null) ||
        (terminalExecutions.has(view.status) && view.ended_at === null) ||
        (!terminalExecutions.has(view.status) && view.ended_at !== null)
      )
        throw new Error("Invalid skill execution state transition");
      this.db
        .query(
          "UPDATE skill_executions SET view=? WHERE run_id=? AND execution_id=?",
        )
        .run(JSON.stringify(view), view.run_id, view.execution_id);
      event = this.append(view.run_id, eventType, summary, {
        execution_id: view.execution_id,
        root_execution_id: view.root_execution_id,
        status: view.status,
        actions: view.actions,
        calls: view.calls,
        details,
      });
    })();
    if (event) this.notify(event);
  }

  reconcileSkillExecutions(runId: string): void {
    const notifications: ActivityEvent[] = [];
    this.db.transaction(() => {
      // Unlike snapshots, recovery must inspect the complete permanent ledger.
      const rows = this.db
        .query<{ view: string }, [string]>(
          "SELECT view FROM skill_executions WHERE run_id=? AND json_extract(view,'$.status') IN ('accepted','running','cancel_requested')",
        )
        .all(runId);
      for (const row of rows) {
        const view = this.readExecutionView(row.view);
        const neverDispatched =
          view.status === "accepted" && view.started_at === null;
        view.status = neverDispatched ? "cancelled" : "unknown";
        view.ended_at = new Date().toISOString();
        view.error = neverDispatched
          ? "Previous process ended before skill dispatch; no program is replayed"
          : "Previous process ended after skill dispatch; effects may be unknown; no program is replayed";
        this.db
          .query(
            "UPDATE skill_executions SET view=? WHERE run_id=? AND execution_id=?",
          )
          .run(JSON.stringify(view), runId, view.execution_id);
        notifications.push(
          this.append(runId, `skill.${view.status}`, view.error, {
            execution_id: view.execution_id,
            root_execution_id: view.root_execution_id,
            actions: view.actions,
            calls: view.calls,
            deadline_at: view.deadline_at,
          }),
        );
      }
    })();
    for (const event of notifications) this.notify(event);
  }

  recordTrace(input: TraceInput): TraceRecord | null {
    for (const observer of this.traceObservers) observer(input);
    const retained = this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO trace_budgets(run_id) VALUES(?)").run(input.run_id);
      const budget = this.traceBudget(input.run_id);
      const originalBytes = Buffer.byteLength(canonical(input));
      if (budget.recorded >= budget.max_records || budget.bytes + Math.min(originalBytes + 160, 32768) > budget.max_bytes) {
        this.db.query("UPDATE trace_budgets SET omitted_records=omitted_records+1,omitted_bytes=omitted_bytes+? WHERE run_id=?").run(originalBytes, input.run_id);
        return null;
      }
      const record: Omit<TraceRecord, "trace_seq"> = {
        ...input,
        at: new Date().toISOString(),
        payload: originalBytes > 24576 ? null : input.payload,
        omission: originalBytes > 24576 ? { reason: "record_byte_budget", original_bytes: originalBytes } : null,
      };
      const text = canonical(record);
      const bytes = Buffer.byteLength(text);
      if (bytes > 32768) throw new Error("Trace attribution exceeds record budget");
      const result = this.db.query("INSERT INTO execution_trace(run_id,payload,bytes) VALUES(?,?,?)").run(input.run_id, text, bytes);
      this.db.query("UPDATE trace_budgets SET recorded=recorded+1,bytes=bytes+?,omitted_records=omitted_records+?,omitted_bytes=omitted_bytes+? WHERE run_id=?")
        .run(bytes, record.omission ? 1 : 0, record.omission ? originalBytes : 0, input.run_id);
      return { ...record, trace_seq: Number(result.lastInsertRowid) };
    })();
    this.notifyHistory(input.run_id);
    return retained;
  }

  private saveEvidenceObject(runId: string, kind: string, key: string, value: unknown): boolean {
    const text = canonical(value);
    if (Buffer.byteLength(text) > 65536) throw new Error("Evidence object exceeds 64 KiB budget");
    return this.db.query("INSERT OR IGNORE INTO evidence_objects(run_id,kind,object_key,payload) VALUES(?,?,?,?)").run(runId, kind, key, text).changes > 0;
  }

  recordDeathEpisode(runId: string, episode: DeathEpisode): void {
    const snapshot = JSON.stringify(episode.last_observation);
    const state = episode.last_observation?.data ?? null;
    const stateBytes = Buffer.byteLength(JSON.stringify(state));
    const references = [...new Set(episode.event_seqs)];
    const value: SavedDeathEpisode = {
      ...episode,
      event_seqs: references.slice(-256),
      last_observation: Buffer.byteLength(snapshot) <= 24576 ? episode.last_observation : null,
      last_authorized_state: stateBytes <= 8192 ? state : null,
      state_omission: stateBytes > 8192 ? { reason: "snapshot_byte_budget", original_bytes: stateBytes } : null,
      observation_omission: Buffer.byteLength(snapshot) > 24576 ? { reason: "snapshot_byte_budget", original_bytes: Buffer.byteLength(snapshot), observation_seq: episode.last_observation?.observation_seq } : null,
      event_reference_omission: references.length > 256 ? { reason: "event_reference_budget", omitted: references.length - 256 } : null,
    };
    let event: ActivityEvent | undefined;
    this.db.transaction(() => {
      if (this.saveEvidenceObject(runId, "death", episode.death_id, value))
        event = this.append(runId, "learning.death_episode", "Retained authorized death context", { death_id: episode.death_id, session_id: episode.session_id, life_id: episode.life_id, root_execution_id: episode.current_root_execution_id, action_id: episode.action_id, event_seqs: value.event_seqs });
    })();
    if (event) this.notify(event);
  }

  saveOpportunity(value: ImprovementOpportunity): ImprovementOpportunity {
    this.saveEvidenceObject(value.run_id, "opportunity", value.opportunity_id, value);
    return this.opportunity(value.run_id, value.opportunity_id)!;
  }

  /** A caller frontier is explicit and never chased by a preview or commit. */
  beginHistoryProjection(runId: string, desiredThrough?: number): ProjectionCheckpoint {
    return this.db.transaction(() => {
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
      if (!existing) this.db.query("INSERT INTO history_projection_checkpoints(run_id,payload) VALUES(?,?)").run(runId, canonical(checkpoint));
      else if (canonical(existing) !== canonical(checkpoint)) this.db.query("UPDATE history_projection_checkpoints SET payload=? WHERE run_id=? AND payload=?").run(canonical(checkpoint), runId, canonical(existing));
      return checkpoint;
    }).immediate();
  }

  /** Persist only bounded trusted patches; expensive domain interpretation stays readonly. */
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
    this.db.transaction(() => {
      const saved = this.historyProjectionCheckpoint(runId);
      if (!saved || canonical(saved) !== canonical(batch.before)) throw new RuntimeFault("conflict", "History projection checkpoint changed before persistence");
      for (const candidate of batch.candidates) {
        if (candidate.run_id !== runId || candidate.resolution !== null || candidate.event_seqs.length !== 1) throw new Error("Invalid staged opportunity scope");
        const sequence = candidate.event_seqs[0]!;
        const current = this.historySourceRecord(runId, "event", String(sequence), this.historySourceHighwater(runId));
        const pinned = this.historySourceRecord(runId, "event", String(sequence), batch.before.target_through);
        const exact = current ? improvementOpportunityCandidate(this, runId, this.decodeHistorySource("event", current)) : null;
        const available = this.historySourceHighwater(runId);
        const currentExecution = this.historySourceRecord(runId, "execution", candidate.execution_id, available);
        const pinnedExecution = this.historySourceRecord(runId, "execution", candidate.execution_id, batch.before.target_through);
        const skillKey = JSON.stringify([candidate.version.skill_id, candidate.version.version]);
        const currentSkill = this.historySourceRecord(runId, "skill", skillKey, available);
        const pinnedSkill = this.historySourceRecord(runId, "skill", skillKey, batch.before.target_through);
        const patch = batch.patches.find(p => p.type === "put" && p.row.collection === "pending_opportunity" && p.row.key === candidate.opportunity_id);
        if (!exact || canonical(current) !== canonical(pinned) || canonical(currentExecution) !== canonical(pinnedExecution) || canonical(currentSkill) !== canonical(pinnedSkill) ||
          canonical(exact) !== canonical(candidate) || !patch || patch.type !== "put" || canonical(patch.row.value) !== canonical(candidate))
          throw new RuntimeFault("conflict", "History opportunity candidate no longer matches exact current source");
      }
      for (const entry of batch.opportunity_bootstrap) {
        const current = this.db.query<{ seq: number; payload: string }, [string, string]>("SELECT rowid AS seq,payload FROM evidence_objects WHERE run_id=? AND kind='opportunity' AND object_key=?").get(runId, entry.value.opportunity_id);
        if (!current || current.seq !== entry.seq || canonical(JSON.parse(current.payload)) !== canonical(entry.value)) throw new RuntimeFault("conflict", "Opportunity bootstrap changed before persistence");
        this.db.query(`INSERT INTO history_opportunity_updates(run_id,opportunity_id,generation,skill_id,version,payload)
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
            this.db.query(`INSERT OR IGNORE INTO history_opportunity_visibility(run_id,opportunity_id,generation)
              SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM evidence_objects WHERE run_id=?1 AND kind='opportunity' AND object_key=?2)`).run(runId, patch.key, batch.before.generation + 1);
            this.saveEvidenceObject(runId, "opportunity", patch.key, candidate);
          }
          this.db.query("INSERT INTO history_projection_rows(run_id,collection,object_key,revision,owner_id,source_id,order_seq,tag,payload,deleted) VALUES(?,?,?,?,NULL,NULL,0,NULL,NULL,1)").run(runId, patch.collection, patch.key, batch.after.revision);
        } else {
          const row = patch.row;
          this.db.query("INSERT INTO history_projection_rows(run_id,collection,object_key,revision,owner_id,source_id,order_seq,tag,payload,deleted) VALUES(?,?,?,?,?,?,?,?,?,0)")
            .run(runId, row.collection, row.key, batch.after.revision, row.owner_id, row.source_id, row.order_seq, row.tag, canonical(row.value));
        }
      }
      if (publication) {
        for (const collection of ["pending_opportunity", "dirty_detection", "dirty_outcome", "dirty_objective", "objective_job", "dirty_evidence", "evidence_job"] as const) {
          if (this.historyProjectionCount(runId, batch.after.revision, { collection }) !== 0) throw new Error("Cannot publish a partial history generation");
        }
        this.db.query("INSERT INTO history_projection_generations(run_id,generation,revision,source_through,metric_change_seq) VALUES(?,?,?,?,?)")
          .run(runId, batch.after.generation, batch.after.revision, batch.after.source_through, batch.after.published_metric_change_seq);
      }
      if (!changed) return;
      const result = this.db.query("UPDATE history_projection_checkpoints SET payload=? WHERE run_id=? AND payload=?").run(canonical(batch.after), runId, canonical(batch.before));
      if (result.changes !== 1) throw new RuntimeFault("conflict", "History projection checkpoint changed during persistence");
    }).immediate();
  }

  hasMeasuredSkillExecution(runId: string, ref: SkillRef): boolean {
    return this.db.query<{ measured: number }, [string, string, number]>(
      "SELECT 1 AS measured FROM skill_executions WHERE run_id=? AND skill_id=? AND version=? AND json_extract(view,'$.started_at') IS NOT NULL AND json_extract(view,'$.status') IN ('succeeded','blocked','failed','unknown','cancelled') LIMIT 1",
    ).get(runId, ref.skill_id, ref.version) !== null;
  }

  resolveOpportunity(runId: string, id: string, resolution: NonNullable<ImprovementOpportunity["resolution"]>): ImprovementOpportunity {
    return this.db.transaction(() => {
      const value = this.opportunity(runId, id);
      if (!value) throw new Error("Improvement opportunity not found");
      if (value.resolution) {
        const { at: _at, ...existing } = value.resolution;
        const { at: _newAt, ...proposed } = resolution;
        if (canonical(existing) !== canonical(proposed)) throw new Error("Improvement resolution is immutable");
        return value;
      }
      value.resolution = resolution;
      this.db.query("UPDATE evidence_objects SET payload=? WHERE run_id=? AND kind='opportunity' AND object_key=?").run(canonical(value), runId, id);
      return value;
    })();
  }

  retainWorkingPrograms(runId: string, sessionId: string): WorkingProgram[] {
    const run = this.getRun(runId);
    if (!run || !sessionId || run.session_id !== sessionId) throw new Error("Working library requires actual same-session lineage");
    const executions = this.allSkillExecutions(runId);
    const candidates: WorkingProgram[] = [];
    for (const root of this.skills(runId)) {
      if (!root.entry || root.state !== "validated" || root.validation.runtime_version !== SKILL_API_VERSION || root.validation.api_version !== 5 ||
        root.validation.validator_version !== 5 || root.validation.compatibility_hash !== run.compatibility_hash) continue;
      const skills: SkillView[] = [];
      const seen = new Set<string>();
      const visit = (ref: SkillRef): void => {
        const key = `${ref.skill_id}:${ref.version}`;
        if (seen.has(key)) return;
        seen.add(key);
        const skill = this.skill(runId, ref);
        if (!skill.entry || skill.state !== "validated" || skill.validation.runtime_version !== 5 || skill.validation.api_version !== 5 ||
          skill.validation.validator_version !== 5 || skill.validation.compatibility_hash !== run.compatibility_hash)
          throw new Error("Working dependency has incompatible executable validation");
        for (const dependency of skill.dependencies) visit(dependency);
        skills.push(skill);
      };
      visit(root);
      const value: WorkingProgram = { session_id: sessionId, model_id: run.model_id, source_run_id: runId, root: { skill_id: root.skill_id, version: root.version }, hash: root.hash, qualification: "working_candidate", measured_execution_ids: executions.filter((item) => item.skill_id === root.skill_id && item.version === root.version && item.started_at !== null && terminalExecutions.has(item.status)).map((item) => item.execution_id), skills };
      candidates.push(value);
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM working_programs WHERE session_id=? AND model_id=?").run(sessionId, run.model_id);
      for (const value of candidates)
        this.db.query("INSERT INTO working_programs(session_id,model_id,skill_id,version,payload) VALUES(?,?,?,?,?)").run(sessionId, run.model_id, value.root.skill_id, value.root.version, canonical(value));
    })();
    return candidates;
  }

  async hydrateWorkingPrograms(modelId: string, sessionId: string, runId: string, manager: Pick<SkillManager, "importSnapshot">, beforeCommit: () => void = () => {}): Promise<SkillView[]> {
    const run = this.getRun(runId);
    if (!run || run.model_id !== modelId || run.session_id !== sessionId) throw new Error("Working library scope does not match run");
    const imported = new Map<string, SkillView>();
    for (const candidate of this.workingPrograms(modelId, sessionId)) {
      if (candidate.skills.some((skill) => !skill.entry || skill.validation.runtime_version !== SKILL_API_VERSION || skill.validation.api_version !== 5 ||
        skill.validation.validator_version !== 5 || skill.validation.compatibility_hash !== run.compatibility_hash)) {
        this.event(runId, "skill.working_incompatible", "Retained working sources use an incompatible API/schema/profile contract and were not imported", {
          source_run_id: candidate.source_run_id, skill_api: SKILL_API_VERSION,
        });
        continue;
      }
      for (const skill of candidate.skills) {
        const key = `${skill.skill_id}:${skill.version}`;
        if (!imported.has(key)) imported.set(key, await manager.importSnapshot(runId, skill, beforeCommit));
      }
    }
    return [...imported.values()];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.historyListeners.clear();
    this.traceObservers.clear();
    this.db.close();
  }
}
