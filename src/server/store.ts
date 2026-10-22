import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DeathEpisode, SavedDeathEpisode, ImprovementOpportunity, TraceInput, TracePage, TraceRecord, WorkingProgram } from "../shared/execution-evidence.ts";
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
} from "../shared/contracts.ts";
import type {
  SkillExecutionView,
  SkillRef,
  SkillSpec,
  SkillStartRequest,
  SkillView,
} from "../shared/programs.ts";
import { SKILL_API_VERSION } from "../shared/programs.ts";

export type StoredRun = Omit<
  RunView,
  "action" | "policies" | "skills" | "executions"
> & {
  baseline: Record<string, number>;
};
export interface StoredAction {
  request: GameAction;
  fingerprint: string;
  view: ActionView;
}
interface EventRow {
  event_seq: number;
  run_id: string | null;
  at: string;
  type: string;
  summary: string;
  details: string;
}
interface PolicyRow {
  policy_id: string;
  run_id: string;
  version: number;
  name: string;
  hash: string;
  metadata: string;
}
interface SkillRow {
  skill_id: string;
  run_id: string;
  version: number;
  name: string;
  hash: string;
  metadata: string;
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

export class Store {
  private readonly db: Database;
  private readonly artifactDir: string;
  private readonly listeners = new Set<(event: ActivityEvent) => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.artifactDir = path.join(dataDir, "artifacts");
    mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, "runs.sqlite");
    this.db = new Database(filename, { create: true, strict: true });
    chmodSync(filename, 0o600);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const version =
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0;
    if (version > 4)
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
        PRAGMA user_version=4;
      `);
      const executionColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(skill_executions)").all();
      if (!executionColumns.some((column) => column.name === "admission_ordinal")) {
        this.db.exec("ALTER TABLE skill_executions ADD COLUMN admission_ordinal INTEGER CHECK(admission_ordinal > 0)");
        this.db.exec("UPDATE skill_executions SET admission_ordinal=rowid");
      }
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_executions_ordinal ON skill_executions(admission_ordinal)");
      if (version < 2) this.migrateLegacyRows();
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

  private normalizeRun(payload: string): StoredRun {
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
    const usage = run.usage as StoredRun["usage"] & {
      input_tokens?: number;
      output_tokens?: number;
    };
    if ("input_tokens" in usage || "output_tokens" in usage) {
      const unattributed = () => ({
        uncached_input: null,
        cache_read: null,
        cache_write: null,
        output: 0,
        calls: null,
        known_cost: null,
        legacy_input: null,
      });
      run.usage = {
        uncached_input: null,
        cache_read: null,
        cache_write: null,
        output: usage.output_tokens ?? 0,
        calls: null,
        known_cost: usage.known_cost ?? null,
        legacy_input: usage.input_tokens ?? null,
        by_purpose: {
          authoring: unattributed(),
          planning: unattributed(),
          replanning: unattributed(),
          improvement: unattributed(),
          other: unattributed(),
        },
      };
    }
    return run;
  }

  private migrateLegacyRows(): void {
    const runs = this.db
      .query<{ run_id: string; payload: string }, []>(
        "SELECT run_id,payload FROM runs",
      )
      .all();
    const saveRun = this.db.query("UPDATE runs SET payload=? WHERE run_id=?");
    for (const row of runs)
      saveRun.run(JSON.stringify(this.normalizeRun(row.payload)), row.run_id);
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

  events(runId: string | null = null, after = 0, limit = 100): ActivityEvent[] {
    const cap = Math.max(1, Math.min(500, limit));
    const rows = runId
      ? this.db
          .query<EventRow, [string, number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE run_id=? AND event_seq>? ORDER BY event_seq DESC LIMIT ?",
          )
          .all(runId, after, cap)
      : this.db
          .query<EventRow, [number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE event_seq>? ORDER BY event_seq DESC LIMIT ?",
          )
          .all(after, cap);
    return rows
      .reverse()
      .map((row) => ({ ...row, details: JSON.parse(row.details) as Json }));
  }

  eventsAfter(
    runId: string | null,
    after: number,
    limit: number,
  ): ActivityEvent[] {
    const cap = Math.max(1, Math.min(500, limit));
    const rows = runId
      ? this.db
          .query<EventRow, [string, number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE run_id=? AND event_seq>? ORDER BY event_seq ASC LIMIT ?",
          )
          .all(runId, after, cap)
      : this.db
          .query<EventRow, [number, number]>(
            "SELECT event_seq,run_id,at,type,summary,details FROM events WHERE event_seq>? ORDER BY event_seq ASC LIMIT ?",
          )
          .all(after, cap);
    return rows.map((row) => ({
      ...row,
      details: JSON.parse(row.details) as Json,
    }));
  }

  lastEventSeq(): number {
    return (
      this.db
        .query<{ cursor: number }, []>(
          "SELECT COALESCE(MAX(event_seq),0) AS cursor FROM events",
        )
        .get()?.cursor ?? 0
    );
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
  }

  lastRun(): StoredRun | null {
    const row = this.db
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
    return this.db
      .query<{ payload: string }, [number]>(
        "SELECT payload FROM runs ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(cap)
      .map((row) => this.normalizeRun(row.payload));
  }

  getRun(id: string): StoredRun | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runs WHERE run_id=?",
      )
      .get(id);
    return row ? this.normalizeRun(row.payload) : null;
  }

  getAction(runId: string, id: string): StoredAction | null {
    const row = this.db
      .query<
        { request: string; fingerprint: string; view: string },
        [string, string]
      >(
        "SELECT request,fingerprint,view FROM actions WHERE run_id=? AND action_id=?",
      )
      .get(runId, id);
    return row
      ? {
          request: JSON.parse(row.request) as GameAction,
          fingerprint: row.fingerprint,
          view: { session_id: null, life_id: null, ...JSON.parse(row.view) } as ActionView,
        }
      : null;
  }

  selectedAction(runId: string, target: "current" | "latest", executionId?: string): ActionView | null {
    const row = this.db.query<{ view: string }, [string, string, string | null, string | null, string | null]>(
      "SELECT a.view FROM actions a LEFT JOIN skill_executions e ON e.run_id=a.run_id AND e.execution_id=json_extract(a.view,'$.execution_id') WHERE a.run_id=? AND (?='latest' OR json_extract(a.view,'$.status') IN ('accepted','running','cancel_requested')) AND (? IS NULL OR e.execution_id=? OR e.root_execution_id=?) ORDER BY a.rowid DESC LIMIT 1",
    ).get(runId, target, executionId ?? null, executionId ?? null, executionId ?? null);
    return row ? { session_id: null, life_id: null, ...JSON.parse(row.view) } as ActionView : null;
  }

  admitAction(
    runId: string,
    id: string,
    request: GameAction,
    origin: ActionView["origin"],
    executionId: string | null = null,
  ): { action: StoredAction; created: boolean } {
    const requestText = JSON.stringify(request);
    const fingerprint = createHash("sha256").update(requestText).digest("hex");
    let event: ActivityEvent | undefined;
    const result = this.db.transaction(() => {
      const existing = this.getAction(runId, id);
      if (existing) {
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
      } else if (executionId !== null) {
        throw new Error("Only skill actions can link a skill execution");
      }
      const view: ActionView = {
        action_id: id,
        kind: request.kind,
        status: "accepted",
        origin,
        execution_id: executionId,
        session_id: this.getRun(runId)?.session_id ?? null,
        life_id: this.getRun(runId)?.life_id ?? null,
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
      const view = JSON.parse(row.view) as ActionView;
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

  private saveSource(source: string): string {
    const hash = createHash("sha256").update(source).digest("hex");
    const filename = path.join(this.artifactDir, `${hash}.js`);
    if (existsSync(filename)) {
      this.readSource(hash);
    } else {
      const temporary = path.join(
        this.artifactDir,
        `${hash}.${randomUUID()}.tmp`,
      );
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, source, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, filename);
      const directory = openSync(this.artifactDir, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    return hash;
  }

  private readSource(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid stored artifact hash");
    const source = readFileSync(
      path.join(this.artifactDir, `${hash}.js`),
      "utf8",
    );
    if (createHash("sha256").update(source).digest("hex") !== hash)
      throw new Error("Stored artifact integrity check failed");
    return source;
  }

  registerPolicy(
    runId: string,
    spec: PolicySpec,
    authoringTurn: number,
  ): PolicyView {
    const hash = this.saveSource(spec.source);
    let event: ActivityEvent | undefined;
    const policy = this.db.transaction(() => {
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
          previousView.interval_ms === spec.interval_ms
        )
          return previousView;
      }
      const view: PolicyView = {
        policy_id: previous?.policy_id ?? randomUUID(),
        version: (previous?.version ?? 0) + 1,
        name: spec.name,
        hash,
        state: "draft",
        source: spec.source,
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
      return view;
    })();
    if (event) this.notify(event);
    return policy;
  }

  private hydratePolicy(row: PolicyRow): PolicyView {
    return {
      ...(JSON.parse(row.metadata) as Omit<PolicyView, "source">),
      source: this.readSource(row.hash),
    };
  }

  policies(runId: string): PolicyView[] {
    return this.db
      .query<PolicyRow, [string]>(
        "SELECT policy_id,run_id,version,name,hash,metadata FROM policies WHERE run_id=? ORDER BY name,version",
      )
      .all(runId)
      .map((row) => this.hydratePolicy(row));
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

  registerSkill(
    runId: string,
    spec: SkillSpec & { validation: SkillView["validation"] },
  ): SkillView {
    const hash = this.saveSource(spec.source);
    let event: ActivityEvent | undefined;
    const view = this.db.transaction(() => {
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

  importSkill(runId: string, view: SkillView): SkillView {
    const hash = this.saveSource(view.source);
    if (hash !== view.hash)
      throw new Error("Imported skill artifact hash does not match");
    if (view.state !== "validated")
      throw new Error("Imported skill must be freshly validated");
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

  private hydrateSkill(row: SkillRow): SkillView {
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
    return this.db
      .query<SkillRow, [string]>(
        "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? ORDER BY name,version",
      )
      .all(runId)
      .map((row) => this.hydrateSkill(row));
  }

  namedSkill(runId: string, name: string, version?: number, validated = false): SkillView | null {
    const row = this.db.query<SkillRow, [string, string, number | null, number | null, number]>(
      "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? AND name=? AND (? IS NULL OR version=?) AND (?=0 OR json_extract(metadata,'$.state')='validated') ORDER BY version DESC LIMIT 1",
    ).get(runId, name, version ?? null, version ?? null, validated ? 1 : 0);
    return row ? this.hydrateSkill(row) : null;
  }

  programCatalog(runId: string, after: number, limit: number) {
    const rows = this.db.query<SkillRow & { seq: number }, [string, string, number, number, number]>(
      "SELECT s.rowid AS seq,s.run_id,s.skill_id,s.version,s.name,s.hash,s.metadata FROM skills s JOIN (SELECT name,MAX(version) AS version FROM skills WHERE run_id=? GROUP BY name) latest ON s.name=latest.name AND s.version=latest.version WHERE s.run_id=? AND (?=0 OR s.rowid<?) ORDER BY s.rowid DESC LIMIT ?",
    ).all(runId, runId, after, after, limit + 1);
    const selected = rows.slice(0, limit);
    return { records: selected.map((row) => {
      const value = JSON.parse(row.metadata) as SkillView;
      return { name: row.name, version: row.version, purpose: value.card.purpose.slice(0, 200), state: value.state,
        execution_compatible: value.validation.runtime_version === SKILL_API_VERSION, created_at: value.created_at,
        ...(value.card.purpose.length > 200 ? { purpose_omission: { reason: "catalog_summary", original_characters: value.card.purpose.length } } : {}) };
    }), next_after: selected.at(-1)?.seq ?? after, has_more: rows.length > limit, omissions: [] };
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
      const previous = this.toolCallRecord(runId, callId, "tool_binding");
      if (previous !== null) return previous;
      const value = create();
      this.db.query("INSERT INTO evidence_objects(run_id,kind,object_key,payload) VALUES(?,'tool_binding',?,?)")
        .run(runId, callId, canonical(value));
      return value;
    })();
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

  skill(runId: string, ref: SkillRef): SkillView {
    const row = this.db
      .query<SkillRow, [string, string, number]>(
        "SELECT run_id,skill_id,version,name,hash,metadata FROM skills WHERE run_id=? AND skill_id=? AND version=?",
      )
      .get(runId, ref.skill_id, ref.version);
    if (!row) throw new Error("Skill version not found in this run");
    return this.hydrateSkill(row);
  }

  admitSkill(
    runId: string,
    request: SkillStartRequest,
    lineage?: { parent_execution_id: string; root_execution_id: string },
  ): { view: SkillExecutionView; created: boolean } {
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
          view: { session_id: null, life_id: null, ...JSON.parse(existing.view) } as SkillExecutionView,
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
      const skill = this.skill(runId, request);
      if (skill.state !== "validated")
        throw new Error("Skill is not validated");
      const limits = request.limits;
      if (
        !request.start_key ||
        !Number.isInteger(limits.duration_ms) ||
        limits.duration_ms <= 0 ||
        limits.duration_ms > 600000 ||
        !Number.isInteger(limits.max_actions) ||
        limits.max_actions <= 0 ||
        limits.max_actions > 512 ||
        !Number.isInteger(limits.max_calls) ||
        limits.max_calls <= 0 ||
        limits.max_calls > 2048 ||
        !Number.isInteger(limits.max_depth) ||
        limits.max_depth <= 0 ||
        limits.max_depth > 8
      )
        throw new Error("Invalid skill start limits or key");
      const id = randomUUID();
      let root: SkillExecutionView | null = null;
      if (lineage) {
        const parent = this.skillExecution(runId, {
          execution_id: lineage.parent_execution_id,
        });
        root = this.skillExecution(runId, {
          execution_id: lineage.root_execution_id,
        });
        if (
          !parent ||
          !root ||
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
          if (!next || next.root_execution_id !== root.execution_id)
            throw new Error("Invalid skill execution ancestry");
          ancestor = next;
          depth++;
          if (depth >= root.limits.max_depth)
            throw new Error("Skill execution depth limit reached");
        }
        if (depth >= root.limits.max_depth)
          throw new Error("Skill execution depth limit reached");
        if (Date.parse(root.deadline_at) <= Date.now())
          throw new Error("Skill execution deadline reached");
      }
      const view: SkillExecutionView = {
        skill_id: request.skill_id,
        version: request.version,
        execution_id: id,
        run_id: runId,
        start_key: request.start_key,
        parent_execution_id: lineage?.parent_execution_id ?? null,
        root_execution_id: root?.execution_id ?? id,
        epoch: request.epoch,
        session_id: request.session_id,
        life_id: request.life_id,
        args: request.args,
        limits: root?.limits ?? request.limits,
        status: "accepted",
        started_at: null,
        ended_at: null,
        deadline_at:
          root?.deadline_at ??
          new Date(Date.now() + request.limits.duration_ms).toISOString(),
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

  skillExecution(
    runId: string,
    lookup: { start_key: string } | { execution_id: string },
  ): SkillExecutionView | null {
    const row =
      "start_key" in lookup
        ? this.db
            .query<{ view: string }, [string, string]>(
              "SELECT view FROM skill_executions WHERE run_id=? AND start_key=?",
            )
            .get(runId, lookup.start_key)
        : this.db
            .query<{ view: string }, [string, string]>(
              "SELECT view FROM skill_executions WHERE run_id=? AND execution_id=?",
            )
            .get(runId, lookup.execution_id);
    return row ? ({ session_id: null, life_id: null, ...JSON.parse(row.view) } as SkillExecutionView) : null;
  }

  skillExecutions(runId: string): SkillExecutionView[] {
    return this.db
      .query<{ view: string }, [string]>(
        "SELECT view FROM skill_executions WHERE run_id=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(runId)
      .map((row) => ({ session_id: null, life_id: null, ...JSON.parse(row.view) }) as SkillExecutionView);
  }

  /** Durable root identity, independent of the bounded presentation snapshot. */
  latestRootExecution(runId: string): SkillExecutionView | null {
    const row = this.db.query<{ view: string }, [string]>(
      "SELECT view FROM skill_executions WHERE run_id=? AND parent_execution_id IS NULL ORDER BY rowid DESC LIMIT 1",
    ).get(runId);
    return row ? ({ session_id: null, life_id: null, ...JSON.parse(row.view) } as SkillExecutionView) : null;
  }

  selectedSkillExecution(runId: string, target: "current" | "latest", skillId?: string, version?: number): SkillExecutionView | null {
    const row = this.db.query<{ view: string }, [string, string | null, string | null, number | null, number | null, string]>(
      "SELECT view FROM skill_executions WHERE run_id=? AND ((? IS NULL AND parent_execution_id IS NULL) OR skill_id=?) AND (? IS NULL OR version=?) AND (?='latest' OR json_extract(view,'$.status') IN ('accepted','running','cancel_requested')) ORDER BY rowid DESC LIMIT 1",
    ).get(runId, skillId ?? null, skillId ?? null, version ?? null, version ?? null, target);
    return row ? { session_id: null, life_id: null, ...JSON.parse(row.view) } as SkillExecutionView : null;
  }

  executionReferences(runId: string, executionId?: string) {
    return this.db.query<{ execution_id: string; name: string; version: number; execution_ordinal: number }, [string, string | null, string | null]>(
      "SELECT e.execution_id,s.name,e.version,e.admission_ordinal AS execution_ordinal FROM skill_executions e JOIN skills s ON s.run_id=e.run_id AND s.skill_id=e.skill_id AND s.version=e.version WHERE e.run_id=? AND (? IS NULL OR e.execution_id=?) ORDER BY e.admission_ordinal",
    ).all(runId, executionId ?? null, executionId ?? null);
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
        const view = JSON.parse(row.view) as SkillExecutionView;
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

  /** Complete ledger traversal; the UI snapshot's latest-100 cap is not evidence scope. */
  allSkillExecutions(runId: string): SkillExecutionView[] {
    return this.db.query<{ view: string }, [string]>(
      "SELECT view FROM skill_executions WHERE run_id=? ORDER BY rowid",
    ).all(runId).map(({ view }) => {
      const value = JSON.parse(view) as SkillExecutionView;
      return { ...value, session_id: value.session_id ?? null, life_id: value.life_id ?? null };
    });
  }

  recordTrace(input: TraceInput): TraceRecord | null {
    return this.db.transaction(() => {
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
  }

  private traceBudget(runId: string): TracePage["budget"] {
    const row = this.db.query<{ recorded: number; bytes: number; omitted_records: number; omitted_bytes: number }, [string]>(
      "SELECT recorded,bytes,omitted_records,omitted_bytes FROM trace_budgets WHERE run_id=?",
    ).get(runId);
    return { max_records: 8192, max_bytes: 8 * 1024 * 1024, recorded: 0, bytes: 0, omitted_records: 0, omitted_bytes: 0, ...row };
  }

  tracePage(runId: string, after = 0, limit = 100, executionId?: string): TracePage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid trace cursor or limit");
    const rows = executionId
      ? this.db.query<{ trace_seq: number; payload: string }, [string, number, string, string, number]>(
        "SELECT trace_seq,payload FROM execution_trace WHERE run_id=? AND trace_seq>? AND (json_extract(payload,'$.execution_id')=? OR json_extract(payload,'$.root_execution_id')=?) ORDER BY trace_seq LIMIT ?",
      ).all(runId, after, executionId, executionId, Math.min(limit, 500) + 1)
      : this.db.query<{ trace_seq: number; payload: string }, [string, number, number]>(
        "SELECT trace_seq,payload FROM execution_trace WHERE run_id=? AND trace_seq>? ORDER BY trace_seq LIMIT ?",
      ).all(runId, after, Math.min(limit, 500) + 1);
    const page: TracePage = { records: [], next_after: after, has_more: false, budget: this.traceBudget(runId) };
    for (const row of rows) {
      const record = { ...JSON.parse(row.payload), trace_seq: row.trace_seq } as TraceRecord;
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
    const row = this.db.query<{ payload: string }, [string, number]>(
      "SELECT payload FROM execution_trace WHERE run_id=? AND trace_seq=?",
    ).get(runId, sequence);
    return row ? { ...JSON.parse(row.payload), trace_seq: sequence } as TraceRecord : null;
  }

  private saveEvidenceObject(runId: string, kind: string, key: string, value: unknown): boolean {
    const text = canonical(value);
    if (Buffer.byteLength(text) > 65536) throw new Error("Evidence object exceeds 64 KiB budget");
    return this.db.query("INSERT OR IGNORE INTO evidence_objects(run_id,kind,object_key,payload) VALUES(?,?,?,?)").run(runId, kind, key, text).changes > 0;
  }

  evidenceObjects<T>(runId: string, kind: "death" | "opportunity"): T[] {
    return this.db.query<{ payload: string }, [string, string]>(
      "SELECT payload FROM evidence_objects WHERE run_id=? AND kind=? ORDER BY rowid",
    ).all(runId, kind).map(({ payload }) => JSON.parse(payload) as T);
  }

  evidenceObjectRows<T>(runId: string, kind: "opportunity", after: number, limit: number): { seq: number; value: T }[] {
    return this.db.query<{ seq: number; payload: string }, [string, string, number, number]>(
      "SELECT rowid AS seq,payload FROM evidence_objects WHERE run_id=? AND kind=? AND rowid>? ORDER BY rowid LIMIT ?",
    ).all(runId, kind, after, limit).map((row) => ({ seq: row.seq, value: JSON.parse(row.payload) as T }));
  }

  skillExecutionRows(runId: string, after: number, limit: number): { seq: number; value: SkillExecutionView }[] {
    return this.db.query<{ seq: number; view: string }, [string, number, number]>(
      "SELECT rowid AS seq,view FROM skill_executions WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT ?",
    ).all(runId, after, limit).map((row) => ({ seq: row.seq, value: { session_id: null, life_id: null, ...JSON.parse(row.view) } as SkillExecutionView }));
  }

  recordDeathEpisode(runId: string, episode: DeathEpisode): void {
    const snapshot = JSON.stringify(episode.last_observation);
    const references = [...new Set(episode.event_seqs)];
    const value: SavedDeathEpisode = {
      ...episode,
      event_seqs: references.slice(-256),
      last_observation: Buffer.byteLength(snapshot) <= 24576 ? episode.last_observation : null,
      last_authorized_player: episode.last_observation?.player ?? null,
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

  deathEpisodesPage(runId: string, after = 0, limit = 32) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid death episode cursor or limit");
    const all = this.evidenceObjects<SavedDeathEpisode>(runId, "death");
    const page = { episodes: [] as SavedDeathEpisode[], next_after: after, has_more: false };
    for (const episode of all.slice(after, after + Math.min(limit, 100))) {
      const candidate = { episodes: [...page.episodes, episode], next_after: page.next_after + 1, has_more: false };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 65536) break;
      page.episodes.push(episode);
      page.next_after++;
    }
    page.has_more = page.next_after < all.length;
    return page;
  }

  saveOpportunity(value: ImprovementOpportunity): ImprovementOpportunity {
    this.saveEvidenceObject(value.run_id, "opportunity", value.opportunity_id, value);
    return this.evidenceObjects<ImprovementOpportunity>(value.run_id, "opportunity").find((item) => item.opportunity_id === value.opportunity_id)!;
  }

  resolveOpportunity(runId: string, id: string, resolution: NonNullable<ImprovementOpportunity["resolution"]>): ImprovementOpportunity {
    return this.db.transaction(() => {
      const value = this.evidenceObjects<ImprovementOpportunity>(runId, "opportunity").find((item) => item.opportunity_id === id);
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
      if (root.state !== "validated" || root.validation.runtime_version !== SKILL_API_VERSION) continue;
      const skills: SkillView[] = [];
      const seen = new Set<string>();
      const visit = (ref: SkillRef): void => {
        const key = `${ref.skill_id}:${ref.version}`;
        if (seen.has(key)) return;
        seen.add(key);
        const skill = this.skill(runId, ref);
        if (skill.state !== "validated") throw new Error("Working dependency is not validated");
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

  workingPrograms(modelId: string, sessionId: string): WorkingProgram[] {
    return this.db.query<{ payload: string }, [string, string, string, string]>(
      "SELECT payload FROM working_programs WHERE model_id=? AND session_id=? AND json_extract(payload,'$.source_run_id')=(SELECT json_extract(payload,'$.source_run_id') FROM working_programs WHERE model_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY rowid",
    ).all(modelId, sessionId, modelId, sessionId).map(({ payload }) => JSON.parse(payload) as WorkingProgram);
  }

  async hydrateWorkingPrograms(modelId: string, sessionId: string, runId: string, manager: Pick<SkillManager, "importSnapshot">, beforeCommit: () => void = () => {}): Promise<SkillView[]> {
    const run = this.getRun(runId);
    if (!run || run.model_id !== modelId || run.session_id !== sessionId) throw new Error("Working library scope does not match run");
    const imported = new Map<string, SkillView>();
    for (const candidate of this.workingPrograms(modelId, sessionId)) {
      if (candidate.skills.some((skill) => skill.validation.runtime_version !== SKILL_API_VERSION)) {
        this.event(runId, "skill.working_incompatible", "Retained working sources use an incompatible skill API and were not imported", {
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
    this.listeners.clear();
    this.db.close();
  }
}
