import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type StoredRun } from "../src/server/store.ts";
import type {
  SkillSpec,
  SkillStartRequest,
  SkillView,
} from "../src/shared/programs.ts";
import { diagnosticAuthorityFixture, executionScopeFixture, minecraftTestAdapter, sha256, skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import { programFingerprint } from "../src/server/program-validation.ts";

const adapter = minecraftTestAdapter(), compatibilityHash = sha256(adapter.descriptor);

const directories: string[] = [];
const stores = new Set<Store>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const result = mkdtempSync(path.join(tmpdir(), "gameharness-skills-"));
  directories.push(result);
  return result;
}
function open(root: string) {
  const store = new Store(root);
  stores.add(store);
  return store;
}
function reopen(root: string, store: Store) {
  store.close();
  stores.delete(store);
  return open(root);
}
function run(store: Store) {
  const value = {
    run_id: crypto.randomUUID(),
    world_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    life_id: 1,
    native_boot_id: "fixture-native-boot", space_epoch: 1, compatibility_hash: compatibilityHash,
    epoch: 1,
    task: "Storage fixture",
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!,
    model_id: "fixture-model",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
    usage: {
      uncached_input: 0,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      calls: 0,
      known_cost: null,
      legacy_input: null,
      accounting_basis: "sdk_reported_subtotal",
      by_purpose: Object.fromEntries(
        ["authoring", "planning", "replanning", "improvement", "other"].map(
          (purpose) => [
            purpose,
            {
              uncached_input: 0,
              cache_read: 0,
              cache_write: 0,
              output: 0,
              calls: 0,
              known_cost: null,
              legacy_input: null,
            },
          ],
        ),
      ) as StoredRun["usage"]["by_purpose"],
    },
    baseline: {},
  } satisfies StoredRun;
  store.saveRun(value);
  return value;
}
function spec(
  name = "fixture",
): SkillSpec & { validation: SkillView["validation"] } {
  return {
    name,
    source:
      'return {status:"completed",summary:"Storage fixture",result:null};',
    card: {
      purpose: "Storage integrity",
      applicability: "Temporary SQLite",
      method: "Durable admission",
      reason: "Lost acknowledgements",
      limitations: "Not gameplay evidence",
    },
    dependencies: [],
    validation: {
      fingerprint: programFingerprint(createHash("sha256").update('return {status:"completed",summary:"Storage fixture",result:null};').digest("hex"), "skill", compatibilityHash),
      runtime_version: 4, api_version: 4, validator_version: 4, compatibility_hash: compatibilityHash,
      formatted_lines: 1,
      complexity: 1,
      nesting: 0,
    },
  };
}
function fixture() {
  const root = directory();
  const store = open(root);
  const value = run(store);
  const skill = store.registerSkill(value.run_id, spec());
  const request: SkillStartRequest = {
    skill_id: skill.skill_id,
    version: skill.version,
    start_key: "stable-start",
    ...executionScopeFixture(value),
    args: { target: "fixture", amount: 2 },
    limits: {
      duration_ms: 120000,
      max_actions: 64,
      max_calls: 256,
      max_depth: 8,
    },
  };
  return { root, store, run: value, skill, request };
}

describe("durable skill admission", () => {
  test("a lost acknowledgement retries one durable identity after restart without authority rechecks", () => {
    const { root, store, run, request } = fixture();
    const first = store.admitSkill(run.run_id, request);
    const changed = { ...run, epoch: run.epoch + 1, status: "paused" as const };
    store.saveRun(changed);
    const restored = reopen(root, store);
    const retry = restored.admitSkill(run.run_id, {
      ...request,
      args: { amount: 2, target: "fixture" },
    });
    expect(retry.created).toBe(false);
    expect(retry.view.execution_id).toBe(first.view.execution_id);
    expect(
      restored.skillExecution(run.run_id, { start_key: request.start_key }),
    ).toEqual(first.view);
    expect(
      restored.skillExecution(run.run_id, {
        execution_id: first.view.execution_id,
      }),
    ).toEqual(first.view);
    expect(
      restored
        .events(run.run_id)
        .filter((event) => event.type === "skill.accepted"),
    ).toHaveLength(1);
    expect(() =>
      restored.admitSkill(run.run_id, {
        ...request,
        start_key: "new-stale-start",
      }),
    ).toThrow();
  });

  test("changed args, limits, epoch, skill or lineage conflict with an existing start key", () => {
    const { store, run, request, skill } = fixture();
    const first = store.admitSkill(run.run_id, request).view;
    const next = store.registerSkill(run.run_id, spec());
    for (const changed of [
      { ...request, args: { target: "different" } },
      { ...request, limits: { ...request.limits, max_actions: 1 } },
      { ...request, epoch: request.epoch + 1 },
      { ...request, version: next.version },
    ])
      expect(() => store.admitSkill(run.run_id, changed)).toThrow();
    expect(() =>
      store.admitSkill(run.run_id, request, {
        parent_execution_id: first.execution_id,
        root_execution_id: first.execution_id,
      }),
    ).toThrow();
    expect(
      store.skillExecution(run.run_id, { start_key: request.start_key })
        ?.version,
    ).toBe(skill.version);
  });

  test("completed retry returns the original result and consumed budgets", () => {
    const { root, store, run, request } = fixture();
    const admitted = store.admitSkill(run.run_id, request).view;
    const terminal = {
      ...admitted,
      status: "succeeded" as const,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      actions: 3,
      calls: 7,
      result: {
        status: "completed" as const,
        summary: "Finished",
        result: { count: 3 },
      },
    };
    store.updateSkillExecution(terminal, "skill.completed", "Finished");
    const restored = reopen(root, store);
    restored.reconcileSkillExecutions(run.run_id);
    expect(restored.admitSkill(run.run_id, request)).toEqual({
      view: terminal,
      created: false,
    });
    expect(() =>
      restored.updateSkillExecution(
        { ...terminal, actions: 0 },
        "skill.progress",
        "Stale state",
      ),
    ).toThrow();
  });

  test("child admission preserves root limits, consumed counters, deadline and lineage", () => {
    const { store, run, request } = fixture();
    const parent = store.admitSkill(run.run_id, request).view;
    const active = {
      ...parent,
      status: "running" as const,
      started_at: new Date().toISOString(),
      actions: 5,
      calls: 9,
    };
    store.updateSkillExecution(active, "skill.started", "Started");
    const childRequest = {
      ...request,
      start_key: "child",
      limits: { ...request.limits, duration_ms: 600000, max_actions: 512 },
    };
    const lineage = {
      parent_execution_id: parent.execution_id,
      root_execution_id: parent.execution_id,
    };
    const child = store.admitSkill(run.run_id, childRequest, lineage).view;
    expect(child.parent_execution_id).toBe(parent.execution_id);
    expect(child.root_execution_id).toBe(parent.execution_id);
    expect(child.deadline_at).toBe(parent.deadline_at);
    expect(child.limits).toEqual(parent.limits);
    expect(
      store.skillExecution(run.run_id, { execution_id: parent.execution_id }),
    ).toEqual(active);
    expect(store.admitSkill(run.run_id, childRequest, lineage).view).toEqual(
      child,
    );
    expect(() =>
      store.updateSkillExecution(
        { ...active, calls: 0 },
        "skill.progress",
        "Reset",
      ),
    ).toThrow();
    expect(() =>
      store.updateSkillExecution(
        { ...child, deadline_at: new Date(Date.now() + 900000).toISOString() },
        "skill.progress",
        "Extend",
      ),
    ).toThrow();
  });

  test("skills, execution IDs, start keys and child ancestry are scoped to their exact run", () => {
    const { store, run: firstRun, request, skill } = fixture();
    const first = store.admitSkill(firstRun.run_id, request).view;
    const other = run(store);
    expect(() => store.skill(other.run_id, skill)).toThrow();
    expect(store.skills(other.run_id)).toEqual([]);
    expect(() => store.admitSkill(other.run_id, request)).toThrow();
    expect(
      store.skillExecution(other.run_id, { execution_id: first.execution_id }),
    ).toBeNull();
    expect(
      store.skillExecution(other.run_id, { start_key: first.start_key }),
    ).toBeNull();
    const own = store.registerSkill(other.run_id, spec());
    const ownRequest = {
      ...request,
      skill_id: own.skill_id,
      session_id: other.session_id,
      life_id: other.life_id,
    };
    expect(() =>
      store.admitSkill(
        other.run_id,
        { ...ownRequest, start_key: "child" },
        {
          parent_execution_id: first.execution_id,
          root_execution_id: first.execution_id,
        },
      ),
    ).toThrow();
    const second = store.admitSkill(other.run_id, ownRequest).view;
    expect(second.execution_id).not.toBe(first.execution_id);
    expect(store.skillExecutions(other.run_id)).toEqual([second]);
  });

  test("restart cancels accepted work and marks dispatched work unknown without resetting consumption", () => {
    const { root, store, run, request } = fixture();
    const queued = store.admitSkill(run.run_id, request).view;
    const live = store.admitSkill(run.run_id, {
      ...request,
      start_key: "live",
    }).view;
    const cancelling = store.admitSkill(run.run_id, {
      ...request,
      start_key: "cancelling",
    }).view;
    const started = new Date().toISOString();
    store.updateSkillExecution(
      { ...live, status: "running", started_at: started, actions: 2, calls: 4 },
      "skill.started",
      "Started",
    );
    store.updateSkillExecution(
      {
        ...cancelling,
        status: "cancel_requested",
        started_at: started,
        actions: 1,
        calls: 3,
      },
      "skill.cancelling",
      "Cancelling",
    );
    const restored = reopen(root, store);
    restored.reconcileSkillExecutions(run.run_id);
    expect(
      restored.skillExecution(run.run_id, { execution_id: queued.execution_id })
        ?.status,
    ).toBe("cancelled");
    const uncertain = restored.skillExecution(run.run_id, {
      execution_id: live.execution_id,
    })!;
    expect(uncertain.status).toBe("unknown");
    expect(uncertain.actions).toBe(2);
    expect(uncertain.calls).toBe(4);
    expect(uncertain.deadline_at).toBe(live.deadline_at);
    expect(
      restored.skillExecution(run.run_id, {
        execution_id: cancelling.execution_id,
      })?.status,
    ).toBe("unknown");
    const cursor = restored.lastEventSeq();
    restored.reconcileSkillExecutions(run.run_id);
    expect(restored.lastEventSeq()).toBe(cursor);
    expect(
      restored.admitSkill(run.run_id, { ...request, start_key: "live" }).view,
    ).toEqual(uncertain);
  });

  test("snapshot truncation never discards permanent point lookups", () => {
    const { store, run, request } = fixture();
    const oldest = store.admitSkill(run.run_id, request).view;
    for (let index = 0; index < 105; index++)
      store.admitSkill(run.run_id, { ...request, start_key: `later-${index}` });
    expect(store.skillExecutions(run.run_id)).toHaveLength(100);
    expect(
      store.skillExecution(run.run_id, { start_key: request.start_key }),
    ).toEqual(oldest);
    expect(
      store.skillExecution(run.run_id, { execution_id: oldest.execution_id }),
    ).toEqual(oldest);
  });

  test("execution updates and their events commit atomically before observers are notified", () => {
    const { store, run, request } = fixture();
    const accepted = store.admitSkill(run.run_id, request).view;
    const observed: string[] = [];
    store.subscribe((event) => {
      if (event.type === "skill.started")
        observed.push(
          store.skillExecution(run.run_id, {
            execution_id: accepted.execution_id,
          })!.status,
        );
    });
    const next = {
      ...accepted,
      status: "running" as const,
      started_at: new Date().toISOString(),
      calls: 1,
    };
    store.updateSkillExecution(next, "skill.started", "Started");
    expect(observed).toEqual(["running"]);
    const cursor = store.lastEventSeq();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      store.updateSkillExecution(
        { ...next, calls: 2 },
        "skill.progress",
        "Progress",
        cyclic as never,
      ),
    ).toThrow();
    expect(
      store.skillExecution(run.run_id, { execution_id: next.execution_id })
        ?.calls,
    ).toBe(1);
    expect(store.lastEventSeq()).toBe(cursor);
  });

  test("leaf action admission durably links its skill owner and rejects ownership changes", () => {
    const { root, store, run: storedRun, request } = fixture();
    const execution = store.admitSkill(storedRun.run_id, request).view;
    const action = {
      kind: "move" as const,
      duration_ms: 200,
      controls: { forward: true },
    };
    store.admitAction(
      storedRun.run_id,
      "owned-action",
      action,
      "skill",
      execution.execution_id,
      skillAuthorityFixture(storedRun, execution),
    );
    const restored = reopen(root, store);
    const retry = restored.admitAction(
      storedRun.run_id,
      "owned-action",
      action,
      "skill",
      execution.execution_id,
      skillAuthorityFixture(storedRun, execution),
    );
    expect(retry.created).toBe(false);
    expect(retry.action.view.origin).toBe("skill");
    expect(retry.action.view.execution_id).toBe(execution.execution_id);
    expect(() =>
      restored.admitAction(
        storedRun.run_id,
        "owned-action",
        action,
        "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(storedRun),
      ),
    ).toThrow();
    const other = run(restored);
    expect(() =>
      restored.admitAction(
        other.run_id,
        "cross-run-owner",
        action,
        "skill",
        execution.execution_id,
        skillAuthorityFixture(storedRun, execution),
      ),
    ).toThrow();
  });
});

test("immutable skill revisions retain exact metadata and reject artifact tampering", () => {
  const { store, run, root, skill } = fixture();
  const revised = store.registerSkill(run.run_id, {
    ...spec(),
    card: { ...spec().card, reason: "Revised metadata" },
    dependencies: [{ skill_id: skill.skill_id, version: skill.version }],
  });
  expect(revised.skill_id).toBe(skill.skill_id);
  expect(revised.version).toBe(2);
  expect(revised.parent_version).toBe(1);
  expect(store.skill(run.run_id, skill).card.reason).toBe(
    "Lost acknowledgements",
  );
  expect(store.skill(run.run_id, revised).dependencies).toEqual([
    { skill_id: skill.skill_id, version: 1 },
  ]);
  writeFileSync(
    path.join(root, "artifacts", `${skill.hash}.js`),
    "return null;",
  );
  expect(() => store.skill(run.run_id, skill)).toThrow();
  expect(() => store.skills(run.run_id)).toThrow();
  expect(() => store.registerSkill(run.run_id, spec())).toThrow();
});

test("schema one migration retains legacy run, action, policy and evidence without fabricating usage", () => {
  const root = directory();
  const db = new Database(path.join(root, "runs.sqlite"));
  db.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
    CREATE TABLE events (event_seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,at TEXT NOT NULL,type TEXT NOT NULL,summary TEXT NOT NULL,details TEXT NOT NULL) STRICT;
    CREATE TABLE actions (run_id TEXT NOT NULL,action_id TEXT NOT NULL,fingerprint TEXT NOT NULL,request TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(run_id,action_id)) STRICT;
    CREATE TABLE policies (policy_id TEXT NOT NULL,run_id TEXT NOT NULL,version INTEGER NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(policy_id,version),UNIQUE(run_id,name,version)) STRICT;
    PRAGMA user_version=1;
  `);
  const legacy = {
    run_id: "legacy-run",
    started_at: "2026-01-01T00:00:00.000Z",
    epoch: 3,
    usage: { input_tokens: 42, output_tokens: 7, known_cost: 0.25 },
    baseline: { oak_log: 2 },
  };
  db.query("INSERT INTO runs VALUES(?,?,?)").run(
    legacy.run_id,
    legacy.started_at,
    JSON.stringify(legacy),
  );
  db.query(
    "INSERT INTO events(run_id,at,type,summary,details) VALUES(?,?,?,?,?)",
  ).run(
    legacy.run_id,
    legacy.started_at,
    "legacy.evidence",
    "Prior evidence",
    '{"count":2}',
  );
  db.query("INSERT INTO actions VALUES(?,?,?,?,?)").run(
    legacy.run_id,
    "prior-action",
    "prior-fingerprint",
    '{"kind":"look","yaw":0,"pitch":0}',
    JSON.stringify({
      action_id: "prior-action",
      origin: "strategist",
      status: "succeeded",
      summary: "Prior action",
    }),
  );
  const source = 'return {kind:"continue"};';
  const hash = createHash("sha256").update(source).digest("hex");
  mkdirSync(path.join(root, "artifacts"));
  writeFileSync(path.join(root, "artifacts", `${hash}.js`), source);
  db.query("INSERT INTO policies VALUES(?,?,?,?,?,?)").run(
    "prior-policy",
    legacy.run_id,
    1,
    "prior",
    hash,
    JSON.stringify({
      policy_id: "prior-policy",
      version: 1,
      name: "prior",
      hash,
      state: "draft",
    }),
  );
  db.close();
  const store = open(root);
  const restored = store.getRun(legacy.run_id)!;
  expect(restored.baseline).toEqual({ oak_log: 2 });
  expect(restored.usage.legacy_input).toBe(42);
  expect(restored.usage.uncached_input).toBeNull();
  expect(restored.usage.cache_read).toBeNull();
  expect(restored.usage.cache_write).toBeNull();
  expect(restored.usage.output).toBe(7);
  expect(restored.usage.calls).toBeNull();
  expect(restored.usage.known_cost).toBe(0.25);
  const retained = new Database(path.join(root, "runs.sqlite"), { readonly: true });
  try {
    expect(retained.query<{ payload: string }, [string]>("SELECT payload FROM runs WHERE run_id=?")
      .get(legacy.run_id)?.payload).toBe(JSON.stringify(legacy));
  } finally { retained.close(); }
  expect(store.events(legacy.run_id)[0]?.details).toEqual({ count: 2 });
  expect(
    store.getAction(legacy.run_id, "prior-action")?.view.execution_id,
  ).toBeNull();
  expect(store.policies(legacy.run_id)[0]?.source).toBe(source);
  expect(store.policies(legacy.run_id)[0]?.backend).toBe("javascript");
  expect(store.policies(legacy.run_id)[0]?.choices).toBeNull();
  expect(store.skills(legacy.run_id)).toEqual([]);
  expect(store.skillExecutions(legacy.run_id)).toEqual([]);
  const authored = store.registerSkill(legacy.run_id, spec());
  expect(store.skill(legacy.run_id, authored)).toEqual(authored);
  const restoredAgain = reopen(root, store);
  expect(restoredAgain.getRun(legacy.run_id)?.usage).toEqual(restored.usage);
  expect(
    restoredAgain.getAction(legacy.run_id, "prior-action")?.fingerprint,
  ).toBe("prior-fingerprint");
});
