import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EvaluationConfig, PlatformEvidenceAuthorization, PlatformEvidenceReference } from "./contracts.ts";
import { createEvaluationConfig, evaluationIdentifier } from "./config.ts";
import type { EvaluationOutcome } from "./results.ts";

export const MAX_UNSUCCESSFUL_LIVE_ATTEMPTS = 2;
export interface AttemptMetadata {
  readonly reportDirectory: string;
  readonly promptRevision?: string;
  readonly scenarioId?: string;
}
export interface AttemptSettlement {
  readonly outcome: EvaluationOutcome;
  /** Actual reported usage only. Missing usage/pricing remains null, never zero-filled. */
  readonly usage: unknown | null;
  readonly evidence: readonly string[];
}
export interface AttemptRecord {
  readonly attemptId: string;
  readonly hypothesisId: string;
  readonly platformEvidenceRevision: string;
  readonly state: "reserved" | "settled" | "interrupted";
  readonly reservedAt: string;
  readonly finishedAt: string | null;
  readonly ownerPid: number;
  readonly config: EvaluationConfig;
  readonly metadata: AttemptMetadata;
  readonly settlement: AttemptSettlement | null;
  readonly interruption: string | null;
}
type HypothesisRow = { revision: string; snapshot: string };
type AttemptRow = { attempt_id: string; hypothesis_id: string; revision: string; state: AttemptRecord["state"]; reserved_at: string; finished_at: string | null; owner_pid: number; config: string; metadata: string; settlement: string | null; interruption: string | null; unsuccessful: number };
type Snapshot = Record<string, string>;

/** Own every fixed SQL statement, including Bun 1.3 query-cache overflow. */
class GovernanceDatabase {
  readonly #statements = new Map<string, Statement>();
  constructor(private readonly database: Database) {}
  query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<Row, Params> {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    // Each fixed SQL string has one row/binding shape at its typed call sites.
    return statement as Statement<Row, Params>;
  }
  exec(sql: string): void { this.database.exec(sql); }
  transaction<T>(operation: () => T) { return this.database.transaction(operation); }
  close(): void {
    for (const statement of this.#statements.values()) statement.finalize();
    this.#statements.clear();
    this.database.close(true);
  }
}

/** Shared private SQLite authority for diagnostics and immutable study admission. */
export function openGovernanceDatabase(governanceRoot: string): GovernanceDatabase {
  mkdirSync(governanceRoot, { recursive: true, mode: 0o700 });
  const root = lstatSync(governanceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Governance storage must be a real private directory");
  chmodSync(governanceRoot, 0o700);
  const path = join(governanceRoot, "attempts.sqlite");
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  return new GovernanceDatabase(db);
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be concrete and nonempty`);
  return value.trim();
}
function digest(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Platform evidence must be a real regular file");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function record(row: AttemptRow): AttemptRecord {
  return {
    attemptId: row.attempt_id, hypothesisId: row.hypothesis_id, platformEvidenceRevision: row.revision,
    state: row.state, reservedAt: row.reserved_at, finishedAt: row.finished_at, ownerPid: row.owner_pid,
    config: JSON.parse(row.config), metadata: JSON.parse(row.metadata),
    settlement: row.settlement === null ? null : JSON.parse(row.settlement), interruption: row.interruption,
  };
}

/** Private, cross-process ledger. Directory/model/prompt changes never create a new allowance. */
export class AttemptLedger {
  readonly #db: GovernanceDatabase;
  readonly #projectRoot: string;

  constructor(governanceRoot: string, options: { projectRoot?: string } = {}) {
    this.#projectRoot = realpathSync(options.projectRoot ?? process.cwd());
    this.#db = openGovernanceDatabase(governanceRoot);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS hypotheses (hypothesis_id TEXT PRIMARY KEY, revision TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_evidence (
        hypothesis_id TEXT NOT NULL, revision TEXT NOT NULL, authorized_at TEXT NOT NULL,
        reason TEXT NOT NULL, references_json TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY (hypothesis_id, revision)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY, hypothesis_id TEXT NOT NULL REFERENCES hypotheses(hypothesis_id), revision TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','settled','interrupted')), reserved_at TEXT NOT NULL, finished_at TEXT,
        owner_pid INTEGER NOT NULL, config TEXT NOT NULL, metadata TEXT NOT NULL,
        settlement TEXT, interruption TEXT, unsuccessful INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS attempts_hypothesis_revision ON attempts(hypothesis_id, revision);
    `);
  }

  close(): void { this.#db.close(); }

  #snapshot(): Snapshot {
    const hashes: Snapshot = {};
    const visit = (path: string): void => {
      if (!existsSync(path)) return;
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) return;
      if (entry.isDirectory()) {
        for (const name of readdirSync(path).sort()) visit(join(path, name));
      } else if (entry.isFile()) hashes[realpathSync(path)] = digest(path);
    };
    for (const root of ["src", "sandbox", "native/minecraft/src", "native/minecraft/build/libs"]) visit(join(this.#projectRoot, root));
    for (const name of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties"]) visit(join(this.#projectRoot, "native/minecraft", name));
    return hashes;
  }

  admitAttempt(config: EvaluationConfig, metadata: AttemptMetadata): AttemptRecord {
    // Revalidate the public boundary even for a caller that did not use the factory.
    const checked = createEvaluationConfig({ discoveredModels: [config.model], modelId: config.model.id,
      purpose: config.purpose, justification: config.justification ?? undefined, hypothesisId: config.hypothesisId,
      platformEvidenceRevision: config.platformEvidenceRevision, caps: config.caps });
    nonempty(metadata.reportDirectory, "reportDirectory");
    const serializedConfig = JSON.stringify(checked);
    const serializedMetadata = JSON.stringify(metadata);
    return this.#db.transaction(() => {
      let hypothesis = this.#db.query<HypothesisRow, [string]>("SELECT revision,snapshot FROM hypotheses WHERE hypothesis_id=?").get(checked.hypothesisId);
      if (!hypothesis) {
        const snapshot = JSON.stringify(this.#snapshot());
        this.#db.query("INSERT INTO hypotheses VALUES (?,?,?)").run(checked.hypothesisId, checked.platformEvidenceRevision, snapshot);
        this.#db.query("INSERT INTO platform_evidence VALUES (?,?,?,?,?,?)").run(checked.hypothesisId, checked.platformEvidenceRevision, new Date().toISOString(), "Initial platform baseline; not an authorization to erase failures", "[]", snapshot);
        hypothesis = { revision: checked.platformEvidenceRevision, snapshot };
      }
      if (hypothesis.revision !== checked.platformEvidenceRevision)
        throw new Error("Platform evidence revision is not current; explicitly authorize concrete changed platform evidence first");
      const count = this.#db.query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM attempts WHERE hypothesis_id=? AND revision=? AND unsuccessful=1").get(checked.hypothesisId, hypothesis.revision)!.count;
      if (count >= MAX_UNSUCCESSFUL_LIVE_ATTEMPTS)
        throw new Error("Two unsuccessful or in-flight live attempts already exist for this hypothesis; new concrete platform evidence is required");
      const attemptId = crypto.randomUUID();
      const reservedAt = new Date().toISOString();
      this.#db.query("INSERT INTO attempts (attempt_id,hypothesis_id,revision,state,reserved_at,owner_pid,config,metadata) VALUES (?,?,?,'reserved',?,?,?,?)")
        .run(attemptId, checked.hypothesisId, hypothesis.revision, reservedAt, process.pid, serializedConfig, serializedMetadata);
      return record(this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE attempt_id=?").get(attemptId)!);
    }).immediate();
  }

  settleAttempt(attemptId: string, settlement: AttemptSettlement): AttemptRecord {
    const outcome = settlement.outcome;
    if (!["pass", "fail", "unknown"].includes(outcome.platform_status)
      || !["goal_verified", "goal_not_verified", "not_run", "unknown"].includes(outcome.agent_status)
      || !["ok", "error", "not_called", "unknown"].includes(outcome.provider_status)
      || !(outcome.goal_verified === null || typeof outcome.goal_verified === "boolean")
      || !Array.isArray(outcome.classification_reason) || !outcome.classification_reason.every(value => typeof value === "string" && value.trim())
      || (outcome.agent_status === "goal_verified") !== (outcome.goal_verified === true))
      throw new Error("Settlement must preserve separate valid platform, agent and provider outcomes");
    if (!Array.isArray(settlement.evidence) || !settlement.evidence.every(value => typeof value === "string" && value.trim()))
      throw new Error("Settlement evidence references must be concrete strings");
    if (settlement.usage === undefined) throw new Error("Missing actual usage must be explicitly null");
    const successful = outcome.platform_status === "pass" && outcome.agent_status === "goal_verified" && outcome.provider_status === "ok";
    const serialized = JSON.stringify(settlement);
    if (!serialized) throw new Error("Settlement must be serializable");
    return this.#db.transaction(() => {
      const result = this.#db.query("UPDATE attempts SET state='settled',settlement=?,unsuccessful=?,finished_at=? WHERE attempt_id=? AND state='reserved'").run(serialized, successful ? 0 : 1, new Date().toISOString(), attemptId);
      if (result.changes !== 1) throw new Error("Only an existing in-flight reservation may be settled; history is immutable");
      return record(this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE attempt_id=?").get(attemptId)!);
    }).immediate();
  }

  interruptAttempt(attemptId: string, reason: string): AttemptRecord {
    const explanation = nonempty(reason, "Interruption reason");
    return this.#db.transaction(() => {
      const result = this.#db.query("UPDATE attempts SET state='interrupted',interruption=?,finished_at=? WHERE attempt_id=? AND state='reserved'").run(explanation, new Date().toISOString(), attemptId);
      if (result.changes !== 1) throw new Error("Only an existing in-flight reservation may be interrupted; history is immutable");
      return record(this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE attempt_id=?").get(attemptId)!);
    }).immediate();
  }

  listAttempts(hypothesisId: string): readonly AttemptRecord[] {
    return this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE hypothesis_id=? ORDER BY rowid").all(hypothesisId).map(record);
  }

  #evidence(reference: PlatformEvidenceReference, hypothesisId: string): { kind: PlatformEvidenceReference["kind"]; path: string; sha256: string; supporting: { path: string; sha256: string }[] } {
    if (!["source", "schema", "native_artifact", "repro"].includes(reference.kind)) throw new Error("Choose a concrete platform evidence kind");
    const given = resolve(this.#projectRoot, nonempty(reference.path, "Evidence path"));
    const path = realpathSync(given);
    if (given !== path) throw new Error("Platform evidence cannot traverse symlinks");
    const inside = relative(this.#projectRoot, path);
    if ((reference.kind === "source" || reference.kind === "schema")
      && (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`) || !/^(src|sandbox|native)[/\\]/.test(inside)))
      throw new Error("Changed source/schema evidence must be project implementation, not a model or prompt descriptor");
    if (/prompt|model-config|credential|auth\.sqlite/i.test(inside))
      throw new Error("A prompt/model/credential change alone is not new platform evidence");
    const supporting: { path: string; sha256: string }[] = [];
    if (reference.kind === "repro") {
      let report: unknown;
      try { report = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error("Reproduction evidence must be a concrete JSON platform-failure report, not a prompt or prose assertion"); }
      const finding = report && typeof report === "object" ? report as Record<string, unknown> : {};
      if (finding.hypothesisId !== hypothesisId || finding.platform_status !== "fail"
        || !Array.isArray(finding.classification_reason)
        || !finding.classification_reason.some(value => typeof value === "string" && value.trim())
        || typeof finding.reproductionCommand !== "string" || !finding.reproductionCommand.trim()
        || !Array.isArray(finding.evidence) || !finding.evidence.length)
        throw new Error("Reproduction evidence must identify a concrete platform failure; model/goal failure alone cannot reset attempts");
      for (const value of finding.evidence) {
        if (!value || typeof value !== "object" || typeof value.path !== "string" || typeof value.sha256 !== "string")
          throw new Error("Platform finding evidence requires real file paths and SHA256 values");
        const givenEvidence = resolve(this.#projectRoot, value.path);
        const evidencePath = realpathSync(givenEvidence);
        if (givenEvidence !== evidencePath || evidencePath === path || digest(evidencePath) !== value.sha256)
          throw new Error("Platform finding evidence hashes must match distinct real regular files");
        supporting.push({ path: evidencePath, sha256: value.sha256 });
      }
    }
    return { kind: reference.kind, path, sha256: digest(path), supporting };
  }

  authorizePlatformEvidence(hypothesisId: string, authorization: PlatformEvidenceAuthorization): void {
    evaluationIdentifier(hypothesisId, "hypothesisId");
    const revision = evaluationIdentifier(authorization.revision, "Evidence revision");
    const reason = nonempty(authorization.reason, "New-platform-evidence reason");
    if (!authorization.references.length) throw new Error("New evidence requires concrete changed source/schema/native-artifact/repro references");
    const references = authorization.references.map(reference => this.#evidence(reference, hypothesisId));
    this.#db.transaction(() => {
      const current = this.#db.query<HypothesisRow, [string]>("SELECT revision,snapshot FROM hypotheses WHERE hypothesis_id=?").get(hypothesisId);
      if (!current) throw new Error("Reserve the initial hypothesis baseline before authorizing a revision");
      if (current.revision === revision || this.#db.query("SELECT 1 FROM platform_evidence WHERE hypothesis_id=? AND revision=?").get(hypothesisId, revision))
        throw new Error("An evidence revision cannot be reused or rolled back");
      if (this.#db.query("SELECT 1 FROM attempts WHERE hypothesis_id=? AND state='reserved'").get(hypothesisId))
        throw new Error("Settle or explicitly interrupt in-flight attempts before authorizing new evidence");
      const previous: Snapshot = JSON.parse(current.snapshot);
      const baseline = this.#db.query<{ authorized_at: string }, [string, string]>("SELECT authorized_at FROM platform_evidence WHERE hypothesis_id=? AND revision=?").get(hypothesisId, current.revision)!;
      const baselineTime = Date.parse(baseline.authorized_at);
      const history = this.#db.query<{ snapshot: string }, [string]>("SELECT snapshot FROM platform_evidence WHERE hypothesis_id=?").all(hypothesisId);
      const previousHashes = new Set(history.flatMap(row => Object.values(JSON.parse(row.snapshot) as Snapshot)));
      const changed = (item: { path: string; sha256: string }) => previous[item.path] !== item.sha256
        && !previousHashes.has(item.sha256)
        && (previous[item.path] !== undefined || lstatSync(item.path).mtimeMs >= baselineTime);
      if (!references.some(reference => changed(reference)
        && (reference.kind !== "repro" || reference.supporting.some(changed))))
        throw new Error("Referenced platform evidence has not changed; model/prompt swaps cannot reset the limit");
      const snapshot = this.#snapshot();
      for (const reference of references) {
        snapshot[reference.path] = reference.sha256;
        for (const item of reference.supporting) snapshot[item.path] = item.sha256;
      }
      // Retain prior external evidence fingerprints so old artifacts cannot be replayed as new.
      const merged = JSON.stringify({ ...previous, ...snapshot });
      this.#db.query("INSERT INTO platform_evidence VALUES (?,?,?,?,?,?)").run(hypothesisId, revision, new Date().toISOString(), reason, JSON.stringify(references), merged);
      this.#db.query("UPDATE hypotheses SET revision=?,snapshot=? WHERE hypothesis_id=?").run(revision, merged, hypothesisId);
    }).immediate();
  }

  listPlatformEvidence(hypothesisId: string): readonly { revision: string; authorizedAt: string; reason: string; references: readonly { kind: string; path: string; sha256: string }[] }[] {
    return this.#db.query<{ revision: string; authorized_at: string; reason: string; references_json: string }, [string]>("SELECT revision,authorized_at,reason,references_json FROM platform_evidence WHERE hypothesis_id=? ORDER BY rowid")
      .all(hypothesisId).map(row => ({ revision: row.revision, authorizedAt: row.authorized_at, reason: row.reason, references: JSON.parse(row.references_json) }));
  }
}
