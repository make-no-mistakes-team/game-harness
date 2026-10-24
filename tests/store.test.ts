import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type StoredRun } from "../src/server/store.ts";
import type { GameAction, PolicySpec } from "../src/shared/contracts.ts";
import { diagnosticAuthorityFixture, minecraftTestAdapter, sha256 } from "./helpers/adapter-contract.ts";
import { programFingerprint } from "../src/server/program-validation.ts";
import { createHash } from "node:crypto";

const adapter = minecraftTestAdapter(), compatibilityHash = sha256(adapter.descriptor);

const directories: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "gameharness-store-"));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  const run: StoredRun = {
    run_id: crypto.randomUUID(),
    world_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    life_id: 1,
    native_boot_id: "fixture-native-boot", space_epoch: 1, compatibility_hash: compatibilityHash,
    epoch: 1,
    task: "Observe the ordinary world",
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
      by_purpose: {
        authoring: {
          uncached_input: 0,
          cache_read: 0,
          cache_write: 0,
          output: 0,
          calls: 0,
          known_cost: null,
          legacy_input: null,
        },
        planning: {
          uncached_input: 0,
          cache_read: 0,
          cache_write: 0,
          output: 0,
          calls: 0,
          known_cost: null,
          legacy_input: null,
        },
        replanning: {
          uncached_input: 0,
          cache_read: 0,
          cache_write: 0,
          output: 0,
          calls: 0,
          known_cost: null,
          legacy_input: null,
        },
        improvement: {
          uncached_input: 0,
          cache_read: 0,
          cache_write: 0,
          output: 0,
          calls: 0,
          known_cost: null,
          legacy_input: null,
        },
        other: {
          uncached_input: 0,
          cache_read: 0,
          cache_write: 0,
          output: 0,
          calls: 0,
          known_cost: null,
          legacy_input: null,
        },
      },
    },
    baseline: {},
  };
  store.saveRun(run);
  return { directory, store, run };
}

const move: GameAction = {
  kind: "move",
  duration_ms: 200,
  controls: { forward: true },
};

test("connection epochs advance durably before any run exists and across restarts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gameharness-epochs-"));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  expect(store.nextGameEpoch()).toBe(1);
  expect(store.nextGameEpoch()).toBe(2);
  expect(store.lastRun()).toBeNull();
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(directory);
  stores.push(reopened);
  expect(reopened.nextGameEpoch()).toBe(3);
  const secondConnection = new Store(directory);
  stores.push(secondConnection);
  expect(secondConnection.nextGameEpoch()).toBe(4);
  expect(reopened.nextGameEpoch()).toBe(5);
  expect(reopened.lastRun()).toBeNull();
});

test("legacy connection epochs start above the largest retained run epoch", () => {
  const { directory, store, run } = fixture();
  store.saveRun({
    ...run,
    run_id: "older-high-epoch",
    epoch: 73,
    started_at: "2020-01-01T00:00:00.000Z",
  });
  store.saveRun({
    ...run,
    run_id: "newer-low-epoch",
    epoch: 12,
    started_at: "2030-01-01T00:00:00.000Z",
  });
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const legacy = new Database(path.join(directory, "runs.sqlite"));
  legacy.exec("DROP TABLE store_metadata; PRAGMA user_version=2;");
  legacy.close();
  const reopened = new Store(directory);
  stores.push(reopened);
  expect(reopened.nextGameEpoch()).toBe(74);
  expect(reopened.getRun("older-high-epoch")?.epoch).toBe(73);
  reopened.close();
  stores.splice(stores.indexOf(reopened), 1);
  const restored = new Store(directory);
  stores.push(restored);
  expect(restored.nextGameEpoch()).toBe(75);
});

describe("durable action admission", () => {
  test("lost acknowledgement preserves one action and rejects conflicting retry content", () => {
    const { directory, store, run } = fixture();
    store.admitAction(run.run_id, "stable-request", move, "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run));
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(directory);
    stores.push(reopened);
    const retry = reopened.admitAction(run.run_id, "stable-request", move, "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run));
    expect(retry.created).toBe(false);
    expect(retry.action.view.status).toBe("accepted");
    expect(
      reopened
        .events(run.run_id)
        .filter((event) => event.type === "action.accepted"),
    ).toHaveLength(1);
    expect(() =>
      reopened.admitAction(run.run_id, "stable-request", { ...move, duration_ms: 400 }, "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run)),
    ).toThrow();
    expect(reopened.getAction(run.run_id, "stable-request")?.request).toEqual(
      move,
    );
  });

  test("restart distinguishes never-dispatched admission from uncertain live effects", () => {
    const { store, run } = fixture();
    store.admitAction(run.run_id, "queued", move, "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run));
    const live = store.admitAction(run.run_id, "live", move, "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run))
      .action.view;
    live.status = "running";
    store.saveAction(run.run_id, live);
    store.closeUnfinishedActions(run.run_id);
    expect(store.getAction(run.run_id, "queued")?.view.status).toBe(
      "cancelled",
    );
    expect(store.getAction(run.run_id, "live")?.view.status).toBe("unknown");
    expect(
      store.admitAction(run.run_id, "live", move, "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run)).created,
    ).toBe(false);
    expect(store.getAction(run.run_id, "live")?.view.status).toBe("unknown");
  });
});

test("forward cursor drains old evidence before newer records across page boundaries", () => {
  const { store, run } = fixture();
  const expected = Array.from(
    { length: 27 },
    (_, index) =>
      store.event(run.run_id, "fixture", "Durable evidence", { index })
        .event_seq,
  );
  let cursor = 0;
  const observed: number[] = [];
  while (true) {
    const page = store.eventsAfter(run.run_id, cursor, 5);
    if (!page.length) break;
    observed.push(...page.map((event) => event.event_seq));
    cursor = page[page.length - 1]!.event_seq;
  }
  expect(observed).toEqual(expected);
  expect(store.lastEventSeq()).toBe(expected[expected.length - 1]!);
});

test("recent run history is newest first while older runs remain retrievable", () => {
  const { store, run } = fixture();
  for (let index = 0; index < 55; index++) {
    store.saveRun({
      ...run,
      run_id: `history-${index}`,
      started_at: new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString(),
    });
  }
  const recent = store.runs();
  expect(recent).toHaveLength(50);
  expect(recent[0]?.run_id).toBe("history-54");
  expect(recent[49]?.run_id).toBe("history-5");
  expect(store.runs(2).map((value) => value.run_id)).toEqual([
    "history-54",
    "history-53",
  ]);
  expect(store.getRun("history-0")?.run_id).toBe("history-0");
  expect(store.getRun(run.run_id)).toEqual(run);
});

test("stored artifact tampering is rejected before source can be reused", () => {
  const { store, run, directory } = fixture();
  const spec: PolicySpec = {
    name: "fixture",
    source: 'return {kind:"continue"};',
    backend: "javascript",
    choices: null,
    priority: 0,
    interval_ms: 200,
    card: {
      purpose: "Validate storage integrity",
      applicability: "Storage fixture only",
      method: "Return no game effect",
      reason: "Integrity boundary",
      limitations: "Not gameplay evidence",
    },
  };
  const hash = createHash("sha256").update(spec.source).digest("hex");
  const policy = store.registerPolicy(run.run_id, spec, 0, { api_version: 4, validator_version: 4, runtime_version: 4,
    compatibility_hash: compatibilityHash, fingerprint: programFingerprint(hash, "policy", compatibilityHash), formatted_lines: 1, complexity: 1, nesting: 0 });
  const filename = path.join(directory, "artifacts", `${policy.hash}.js`);
  expect(readFileSync(filename, "utf8")).toBe(spec.source);
  writeFileSync(filename, 'return {kind:"replan",reason:"modified"};');
  expect(() => store.policies(run.run_id)).toThrow("integrity");
});
