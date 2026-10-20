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
import type {
  ActionView,
  ActivityEvent,
  GameAction,
  Json,
  PolicySpec,
  PolicyView,
  RunView,
} from "../shared/contracts.ts";

export type StoredRun = Omit<RunView, "action" | "policies"> & {
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
    if (version > 1)
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
        PRAGMA user_version=1;
      `);
    })();
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
          JSON.stringify(run),
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
    return row ? (JSON.parse(row.payload) as StoredRun) : null;
  }

  getRun(id: string): StoredRun | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runs WHERE run_id=?",
      )
      .get(id);
    return row ? (JSON.parse(row.payload) as StoredRun) : null;
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
          view: JSON.parse(row.view) as ActionView,
        }
      : null;
  }

  admitAction(
    runId: string,
    id: string,
    request: GameAction,
    origin: ActionView["origin"],
  ): { action: StoredAction; created: boolean } {
    const requestText = JSON.stringify(request);
    const fingerprint = createHash("sha256").update(requestText).digest("hex");
    let event: ActivityEvent | undefined;
    const result = this.db.transaction(() => {
      const existing = this.getAction(runId, id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("Action ID already exists with different content");
        return { action: existing, created: false };
      }
      const view: ActionView = {
        action_id: id,
        kind: request.kind,
        status: "accepted",
        origin,
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
    if (!existsSync(filename)) {
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
    if (!/^[a-f0-9]{64}$/.test(row.hash))
      throw new Error("Invalid stored artifact hash");
    const source = readFileSync(
      path.join(this.artifactDir, `${row.hash}.js`),
      "utf8",
    );
    if (createHash("sha256").update(source).digest("hex") !== row.hash)
      throw new Error("Policy artifact integrity check failed");
    return {
      ...(JSON.parse(row.metadata) as Omit<PolicyView, "source">),
      source,
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

  close(): void {
    this.listeners.clear();
    this.db.close();
  }
}
