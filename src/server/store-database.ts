import { type Database, type SQLQueryBindings, type Statement } from "bun:sqlite";

export const STORE_SCHEMA_VERSION = 7;

/** Own every fixed SQL statement, including Bun 1.3 query-cache overflow. */
export class StoreDatabase {
  readonly #statements = new Map<string, Statement>();
  readonly #commitCallbacks: (() => void)[] = [];
  #transactionDepth = 0;
  #closed = false;

  constructor(private readonly database: Database) {}

  query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<Row, Params> {
    if (this.#closed) throw new Error("Store database is closed");
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    // Each fixed SQL string has one row/binding shape at its typed call sites.
    return statement as Statement<Row, Params>;
  }

  exec(sql: string): void { this.database.exec(sql); }
  transaction<T>(operation: () => T) {
    const transaction = this.database.transaction(operation);
    const invoke = (mode: "deferred" | "immediate" | "exclusive"): T => {
      const callbackStart = this.#commitCallbacks.length;
      this.#transactionDepth++;
      let succeeded = false;
      try {
        const result = transaction[mode]();
        succeeded = true;
        return result;
      } finally {
        this.#transactionDepth--;
        if (!succeeded) this.#commitCallbacks.splice(callbackStart);
        if (this.#transactionDepth === 0 && succeeded) {
          const callbacks = this.#commitCallbacks.splice(0);
          for (const callback of callbacks) callback();
        }
      }
    };
    return Object.assign(() => invoke("deferred"), {
      deferred: () => invoke("deferred"), immediate: () => invoke("immediate"), exclusive: () => invoke("exclusive"),
    });
  }

  afterCommit(callback: () => void): void {
    if (this.#transactionDepth > 0) this.#commitCallbacks.push(callback);
    else callback();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      for (const statement of this.#statements.values()) statement.finalize();
    } finally {
      this.#statements.clear();
      this.database.close(true);
    }
  }
}

/** ROWID is the implicit final key: latest means insertion order, not a timestamp. */
export const STORE_OPPORTUNITY_INDEXES = [
  {
    name: "evidence_opportunity_version",
    sql: "CREATE INDEX IF NOT EXISTS evidence_opportunity_version ON evidence_objects(run_id,json_extract(payload,'$.version.run_id'),json_extract(payload,'$.version.skill_id'),json_extract(payload,'$.version.version'),json_extract(payload,'$.version.hash')) WHERE kind='opportunity'",
  },
  {
    name: "evidence_opportunity_family",
    sql: "CREATE INDEX IF NOT EXISTS evidence_opportunity_family ON evidence_objects(run_id,json_extract(payload,'$.version.skill_id')) WHERE kind='opportunity'",
  },
] as const;
