import type { Json } from "../shared/contracts.ts";

export const HISTORY_SOURCE_SCHEMA_VERSION = 6;
export const HISTORY_SOURCE_KINDS = [
  "run",
  "action",
  "execution",
  "event",
  "trace",
  "trace_budget",
  "skill",
] as const;
export type HistorySourceKind = (typeof HISTORY_SOURCE_KINDS)[number];

export type HistorySourceRecord = {
  source_key: string;
  ordinal: number;
  columns: Record<string, Json>;
};
export type HistorySourceChange = {
  change_seq: number;
  run_id: string;
  kind: HistorySourceKind;
  source_key: string;
};
export type HistorySourceChanges = {
  records: HistorySourceChange[];
  next_after: number;
  through: number;
  has_more: boolean;
};
export type HistorySourcePage = {
  records: (HistorySourceRecord & { key_seq: number })[];
  next_after: number;
  through_key: number;
  has_more: boolean;
};

type SourceDefinition = {
  table: string;
  columns: readonly string[];
  keySql: string;
  runSql: string;
  ordinalSql: string;
  lookupSql: string;
};

// Every identifier and expression originates here, never from a caller or a cursor.
function definition(
  table: string,
  columns: readonly string[],
  keySql: string,
  identitySql: string,
): SourceDefinition {
  return Object.freeze({
    table,
    columns: Object.freeze(columns),
    keySql,
    runSql: "run_id",
    ordinalSql: "rowid",
    lookupSql: `SELECT rowid AS ordinal,${keySql} AS source_key,${columns.join(",")} FROM ${table} WHERE run_id=?1 AND ${identitySql}`,
  });
}

export const HISTORY_SOURCE_REGISTRY: Readonly<
  Record<HistorySourceKind, SourceDefinition>
> = Object.freeze({
  run: definition(
    "runs",
    ["run_id", "created_at", "payload"],
    "run_id",
    "run_id=?2",
  ),
  action: definition(
    "actions",
    ["run_id", "action_id", "fingerprint", "request", "view"],
    "action_id",
    "action_id=?2",
  ),
  execution: definition(
    "skill_executions",
    [
      "run_id",
      "execution_id",
      "admission_ordinal",
      "start_key",
      "skill_id",
      "version",
      "parent_execution_id",
      "root_execution_id",
      "fingerprint",
      "request",
      "view",
    ],
    "execution_id",
    "execution_id=?2",
  ),
  event: definition(
    "events",
    ["event_seq", "run_id", "at", "type", "summary", "details"],
    "CAST(event_seq AS TEXT)",
    "event_seq=CAST(?2 AS INTEGER)",
  ),
  trace: definition(
    "execution_trace",
    ["trace_seq", "run_id", "payload", "bytes"],
    "CAST(trace_seq AS TEXT)",
    "trace_seq=CAST(?2 AS INTEGER)",
  ),
  trace_budget: definition(
    "trace_budgets",
    ["run_id", "recorded", "bytes", "omitted_records", "omitted_bytes"],
    "run_id",
    "run_id=?2",
  ),
  skill: definition(
    "skills",
    ["run_id", "skill_id", "version", "name", "hash", "metadata"],
    "json_array(skill_id,version)",
    "skill_id=json_extract(?2,'$[0]') AND version=json_extract(?2,'$[1]')",
  ),
});

export const HISTORY_SOURCE_INDEXES = [
  {
    name: "history_source_changes_run_seq",
    sql: "CREATE INDEX history_source_changes_run_seq ON history_source_changes(run_id,change_seq)",
  },
  {
    name: "history_source_changes_run_kind_key_seq",
    sql: "CREATE INDEX history_source_changes_run_kind_key_seq ON history_source_changes(run_id,kind,source_key,change_seq)",
  },
  {
    name: "history_source_keys_run_kind_seq",
    sql: "CREATE INDEX history_source_keys_run_kind_seq ON history_source_keys(run_id,kind,key_seq)",
  },
] as const;

function qualified(
  expression: string,
  prefix: "OLD" | "NEW",
  source: SourceDefinition,
): string {
  // The registry expressions contain only these fixed identifiers, never string literals.
  return expression.replace(/\b[a-z_]+\b/g, (word) =>
    source.columns.includes(word) || word === "rowid"
      ? `${prefix}.${word}`
      : word,
  );
}

function sourceTriggers(kind: HistorySourceKind) {
  const source = HISTORY_SOURCE_REGISTRY[kind];
  const oldRun = `OLD.${source.runSql}`;
  const newRun = `NEW.${source.runSql}`;
  const oldKey = qualified(source.keySql, "OLD", source);
  const newKey = qualified(source.keySql, "NEW", source);
  const oldIdentity = `run_id=${oldRun} AND kind='${kind}' AND source_key=${oldKey}`;
  const snapshot = `json_object(${source.columns.map((column) => `'${column}',OLD.${column}`).join(",")})`;
  const seal = `
    INSERT INTO history_source_keys(run_id,kind,source_key,created_seq)
      SELECT ${oldRun},'${kind}',${oldKey},0
      WHERE NOT EXISTS(SELECT 1 FROM history_source_versions WHERE ${oldIdentity})
        AND NOT EXISTS(SELECT 1 FROM history_source_keys WHERE ${oldIdentity});
    INSERT INTO history_source_versions(run_id,kind,source_key,change_seq,ordinal,present,payload)
      SELECT ${oldRun},'${kind}',${oldKey},0,OLD.rowid,1,${snapshot}
      WHERE NOT EXISTS(SELECT 1 FROM history_source_versions WHERE ${oldIdentity});
    UPDATE history_source_versions SET payload=${snapshot}
      WHERE ${oldIdentity} AND present=1 AND payload IS NULL
        AND change_seq=(SELECT MAX(change_seq) FROM history_source_versions WHERE ${oldIdentity});`;
  const append = (
    run: string,
    key: string,
    ordinal: string,
    present: 0 | 1,
    condition: string,
  ) => `
    INSERT INTO history_source_changes(run_id,kind,source_key)
      SELECT ${run},'${kind}',${key} WHERE ${condition};
    INSERT INTO history_source_keys(run_id,kind,source_key,created_seq)
      SELECT ${run},'${kind}',${key},last_insert_rowid() WHERE ${condition}
        AND NOT EXISTS(SELECT 1 FROM history_source_keys WHERE run_id=${run} AND kind='${kind}' AND source_key=${key});
    INSERT INTO history_source_versions(run_id,kind,source_key,change_seq,ordinal,present,payload)
      SELECT ${run},'${kind}',${key},
        (SELECT change_seq FROM history_source_changes WHERE run_id=${run} AND kind='${kind}' AND source_key=${key} ORDER BY change_seq DESC LIMIT 1),
        ${ordinal},${present},NULL WHERE ${condition};`;
  const changedIdentity = `${oldRun} IS NOT ${newRun} OR ${oldKey} IS NOT ${newKey}`;
  return [
    {
      name: `history_source_${kind}_insert`,
      table: source.table,
      sql: `CREATE TRIGGER history_source_${kind}_insert AFTER INSERT ON ${source.table}
      WHEN ${newRun} IS NOT NULL BEGIN ${append(newRun, newKey, "NEW.rowid", 1, "1")} END`,
    },
    {
      name: `history_source_${kind}_seal_update`,
      table: source.table,
      sql: `CREATE TRIGGER history_source_${kind}_seal_update BEFORE UPDATE ON ${source.table}
      WHEN ${oldRun} IS NOT NULL BEGIN ${seal} END`,
    },
    {
      name: `history_source_${kind}_update`,
      table: source.table,
      sql: `CREATE TRIGGER history_source_${kind}_update AFTER UPDATE ON ${source.table}
      BEGIN
        ${append(oldRun, oldKey, "OLD.rowid", 0, `${oldRun} IS NOT NULL AND (${changedIdentity})`)}
        ${append(newRun, newKey, "NEW.rowid", 1, `${newRun} IS NOT NULL`)}
      END`,
    },
    {
      name: `history_source_${kind}_seal_delete`,
      table: source.table,
      sql: `CREATE TRIGGER history_source_${kind}_seal_delete BEFORE DELETE ON ${source.table}
      WHEN ${oldRun} IS NOT NULL BEGIN ${seal} END`,
    },
    {
      name: `history_source_${kind}_delete`,
      table: source.table,
      sql: `CREATE TRIGGER history_source_${kind}_delete AFTER DELETE ON ${source.table}
      WHEN ${oldRun} IS NOT NULL BEGIN ${append(oldRun, oldKey, "OLD.rowid", 0, "1")} END`,
    },
  ];
}

export const HISTORY_SOURCE_TRIGGERS = [
  ...HISTORY_SOURCE_KINDS.flatMap(sourceTriggers),
  {
    name: "history_source_versions_seal_once",
    table: "history_source_versions",
    sql: `CREATE TRIGGER history_source_versions_seal_once BEFORE UPDATE ON history_source_versions
      WHEN OLD.present<>1 OR OLD.payload IS NOT NULL OR NEW.payload IS NULL
        OR OLD.run_id IS NOT NEW.run_id OR OLD.kind IS NOT NEW.kind OR OLD.source_key IS NOT NEW.source_key
        OR OLD.change_seq IS NOT NEW.change_seq OR OLD.ordinal IS NOT NEW.ordinal OR OLD.present IS NOT NEW.present
      BEGIN SELECT RAISE(ABORT,'History source versions are immutable after sealing'); END`,
  },
  {
    name: "history_source_versions_no_delete",
    table: "history_source_versions",
    sql: "CREATE TRIGGER history_source_versions_no_delete BEFORE DELETE ON history_source_versions BEGIN SELECT RAISE(ABORT,'History source versions are permanent'); END",
  },
  {
    name: "history_source_changes_no_update",
    table: "history_source_changes",
    sql: "CREATE TRIGGER history_source_changes_no_update BEFORE UPDATE ON history_source_changes BEGIN SELECT RAISE(ABORT,'History source changes are immutable'); END",
  },
  {
    name: "history_source_changes_no_delete",
    table: "history_source_changes",
    sql: "CREATE TRIGGER history_source_changes_no_delete BEFORE DELETE ON history_source_changes BEGIN SELECT RAISE(ABORT,'History source changes are permanent'); END",
  },
] as const;

const kindsSql = HISTORY_SOURCE_KINDS.map((kind) => `'${kind}'`).join(",");
export const HISTORY_SOURCE_SCHEMA_SQL = `
  CREATE TABLE history_source_changes (
    change_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(change_seq>0 AND change_seq<=9007199254740991),
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (${kindsSql})),
    source_key TEXT NOT NULL
  ) STRICT;
  CREATE TABLE history_source_versions (
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (${kindsSql})),
    source_key TEXT NOT NULL,
    change_seq INTEGER NOT NULL CHECK(change_seq>=0 AND change_seq<=9007199254740991),
    ordinal INTEGER NOT NULL,
    present INTEGER NOT NULL CHECK(present IN (0,1)),
    payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
    PRIMARY KEY(run_id,kind,source_key,change_seq),
    CHECK(present=1 OR payload IS NULL),
    CHECK(change_seq>0 OR (present=1 AND payload IS NOT NULL))
  ) STRICT;
  CREATE TABLE history_source_keys (
    key_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(key_seq>0 AND key_seq<=9007199254740991),
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (${kindsSql})),
    source_key TEXT NOT NULL,
    created_seq INTEGER NOT NULL CHECK(created_seq>=0 AND created_seq<=9007199254740991),
    UNIQUE(run_id,kind,source_key)
  ) STRICT;
  CREATE TABLE history_source_bootstrap (
    kind TEXT PRIMARY KEY CHECK(kind IN (${kindsSql})),
    through_ordinal INTEGER NOT NULL CHECK(through_ordinal>=0 AND through_ordinal<=9007199254740991),
    after_ordinal INTEGER NOT NULL CHECK(after_ordinal>=0 AND after_ordinal<=through_ordinal)
  ) STRICT;
  ${HISTORY_SOURCE_INDEXES.map(({ sql }) => `${sql};`).join("\n")}
  ${HISTORY_SOURCE_TRIGGERS.map(({ sql }) => `${sql};`).join("\n")}
`;
