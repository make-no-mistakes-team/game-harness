import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type StoredRun } from "../src/server/store.ts";
import type { GameAction, PolicySpec } from "../src/shared/contracts.ts";

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
    epoch: 1,
    task: "Observe the ordinary world",
    goal: "custom",
    model_id: "fixture-model",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
    usage: { input_tokens: 0, output_tokens: 0, known_cost: null },
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

describe("durable action admission", () => {
  test("lost acknowledgement preserves one action and rejects conflicting retry content", () => {
    const { directory, store, run } = fixture();
    store.admitAction(run.run_id, "stable-request", move, "strategist");
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(directory);
    stores.push(reopened);
    const retry = reopened.admitAction(
      run.run_id,
      "stable-request",
      move,
      "strategist",
    );
    expect(retry.created).toBe(false);
    expect(retry.action.view.status).toBe("accepted");
    expect(
      reopened
        .events(run.run_id)
        .filter((event) => event.type === "action.accepted"),
    ).toHaveLength(1);
    expect(() =>
      reopened.admitAction(
        run.run_id,
        "stable-request",
        { ...move, duration_ms: 400 },
        "strategist",
      ),
    ).toThrow();
    expect(reopened.getAction(run.run_id, "stable-request")?.request).toEqual(
      move,
    );
  });

  test("restart distinguishes never-dispatched admission from uncertain live effects", () => {
    const { store, run } = fixture();
    store.admitAction(run.run_id, "queued", move, "strategist");
    const live = store.admitAction(run.run_id, "live", move, "strategist")
      .action.view;
    live.status = "running";
    store.saveAction(run.run_id, live);
    store.closeUnfinishedActions(run.run_id);
    expect(store.getAction(run.run_id, "queued")?.view.status).toBe(
      "cancelled",
    );
    expect(store.getAction(run.run_id, "live")?.view.status).toBe("unknown");
    expect(
      store.admitAction(run.run_id, "live", move, "strategist").created,
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

test("stored artifact tampering is rejected before source can be reused", () => {
  const { store, run, directory } = fixture();
  const spec: PolicySpec = {
    name: "fixture",
    source: 'return {kind:"continue"};',
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
  const policy = store.registerPolicy(run.run_id, spec, 0);
  const filename = path.join(directory, "artifacts", `${policy.hash}.js`);
  expect(readFileSync(filename, "utf8")).toBe(spec.source);
  writeFileSync(filename, 'return {kind:"replan",reason:"modified"};');
  expect(() => store.policies(run.run_id)).toThrow("integrity");
});
