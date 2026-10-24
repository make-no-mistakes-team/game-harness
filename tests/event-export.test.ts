import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exportEventPage,
  type EventExportOptions,
  type EventExportReader,
  type EventExportResult,
} from "../src/server/event-export.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { emptyRunUsage } from "../src/server/usage.ts";
import type { ActivityEvent, Json } from "../src/shared/contracts.ts";

const directories: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openStore(): Store {
  const directory = mkdtempSync(path.join(tmpdir(), "gameharness-export-"));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  return store;
}

function makeRun(store: Store, task: string): StoredRun {
  const run: StoredRun = {
    run_id: crypto.randomUUID(),
    world_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    life_id: 1,
    // Read-only export coverage intentionally retains the historical run shape.
    native_boot_id: null, space_epoch: null, compatibility_hash: null,
    epoch: 1,
    task,
    goal: "custom",
    model_id: "fixture-model",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
    usage: emptyRunUsage(),
    baseline: {},
  };
  store.saveRun(run);
  return run;
}

function counting(store: Store) {
  const eventsAfter = store.eventsAfter.bind(store);
  const lastEventSeq = store.lastEventSeq.bind(store);
  const calls: Array<{ runId: string | null; after: number; limit: number }> =
    [];
  let watermarks = 0;
  const reader: EventExportReader = {
    eventsAfter(runId, after, limit) {
      calls.push({ runId, after, limit });
      return eventsAfter(runId, after, limit);
    },
    lastEventSeq() {
      watermarks += 1;
      return lastEventSeq();
    },
  };
  return {
    reader,
    calls,
    watermarks: () => watermarks,
  };
}

function sealedReader(): EventExportReader {
  return {
    eventsAfter() {
      throw new Error("eventsAfter called");
    },
    lastEventSeq() {
      throw new Error("lastEventSeq called");
    },
  };
}

function event(
  sequence: number,
  runId: string | null,
  summary = "note",
  details: Json = null,
): ActivityEvent {
  return {
    event_seq: sequence,
    run_id: runId,
    at: "2026-01-02T03:04:05.000Z",
    type: "fixture",
    summary,
    details,
  };
}

function lineOf(
  source: Pick<
    ActivityEvent,
    "event_seq" | "run_id" | "at" | "type" | "summary"
  >,
): string {
  return (
    JSON.stringify({
      event_seq: source.event_seq,
      run_id: source.run_id,
      at: source.at,
      type: source.type,
      summary: source.summary,
    }) + "\n"
  );
}

function pageOptions(
  runId: string,
  overrides: Partial<EventExportOptions> = {},
): EventExportOptions {
  return {
    run_id: runId,
    after: 0,
    through_seq: null,
    max_events: 50,
    max_bytes: 262144,
    ...overrides,
  };
}

function fixedReader(
  events: ActivityEvent[],
  watermark = Number.MAX_SAFE_INTEGER,
) {
  const calls: Array<{ runId: string | null; after: number; limit: number }> =
    [];
  let watermarks = 0;
  const reader: EventExportReader = {
    eventsAfter(runId, after, limit) {
      calls.push({ runId, after, limit });
      return events
        .filter((item) => item.run_id === runId && item.event_seq > after)
        .slice(0, limit);
    },
    lastEventSeq() {
      watermarks += 1;
      return watermark;
    },
  };
  return { reader, calls, watermarks: () => watermarks };
}

function sequences(page: EventExportResult): number[] {
  expect(page.ok).toBe(true);
  if (!page.ok) return [];
  if (page.ndjson === "") return [];
  expect(page.ndjson.endsWith("\n")).toBe(true);
  return page.ndjson
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const parsed = JSON.parse(line) as { event_seq: number };
      return parsed.event_seq;
    });
}

describe("event export", () => {
  test("pages one run across interleaved runs without later events or duplicates", () => {
    const store = openStore();
    const primary = makeRun(store, "Primary task");
    const other = makeRun(store, "Other task");
    const expected: number[] = [];
    for (let index = 0; index < 7; index++) {
      expected.push(
        store.event(primary.run_id, "note", `visible-marker a-${index}`, {
          secret: "hidden-secret-token",
          position: { x: 481516, y: 2342, z: -90210 },
        }).event_seq,
      );
      store.event(other.run_id, "note", `other-${index}`, {
        secret: "other-secret",
      });
      store.event(null, "system", `system-${index}`, {
        secret: "system-secret",
      });
    }
    const probe = counting(store);
    let after = 0;
    let through: number | null = null;
    const seen: number[] = [];
    let raw = "";
    let pages = 0;
    while (pages < 10) {
      const page = exportEventPage(
        probe.reader,
        pageOptions(primary.run_id, {
          after,
          through_seq: through,
          max_events: 2,
        }),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      if (through === null) {
        through = page.through_seq;
        expect(through).toBeGreaterThan(expected[expected.length - 1]!);
        expect(probe.watermarks()).toBe(1);
        store.event(primary.run_id, "note", "late-primary", {
          secret: "late-secret",
        });
        store.event(other.run_id, "note", "late-other", null);
      } else expect(page.through_seq).toBe(through);
      pages += 1;
      raw += page.ndjson;
      const seqs = sequences(page);
      expect(seqs).toHaveLength(page.exported_count);
      seen.push(...seqs);
      expect(page.details_omitted).toBe(true);
      if (!page.has_more) break;
      expect(page.next_after).toBe(seqs[seqs.length - 1]!);
      after = page.next_after;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect(raw).toContain("visible-marker");
    expect(raw).not.toContain("hidden-secret-token");
    expect(raw).not.toContain("481516");
    expect(raw).not.toContain("late-primary");
    expect(probe.watermarks()).toBe(1);
    expect(probe.calls).toHaveLength(pages);
    for (const call of probe.calls)
      expect(call).toEqual({
        runId: primary.run_id,
        after: expect.any(Number),
        limit: 3,
      });
  });

  test("stops exactly at max_events and reports one extra in-range record", () => {
    const store = openStore();
    const run = makeRun(store, "Count");
    const seqs = [1, 2, 3].map(
      (index) =>
        store.event(run.run_id, "note", `n-${index}`, null).event_seq,
    );
    const exact = counting(store);
    const filled = exportEventPage(
      exact.reader,
      pageOptions(run.run_id, { max_events: 3 }),
    );
    expect(filled).toMatchObject({
      ok: true,
      exported_count: 3,
      next_after: seqs[2],
      through_seq: seqs[2],
      has_more: false,
      details_omitted: true,
    });
    expect(sequences(filled)).toEqual(seqs);
    expect(exact.calls).toEqual([
      { runId: run.run_id, after: 0, limit: 4 },
    ]);

    const extra = counting(store);
    const partial = exportEventPage(
      extra.reader,
      pageOptions(run.run_id, { max_events: 2 }),
    );
    expect(partial).toMatchObject({
      ok: true,
      exported_count: 2,
      next_after: seqs[1],
      through_seq: seqs[2],
      has_more: true,
    });
    expect(sequences(partial)).toEqual(seqs.slice(0, 2));
    expect(extra.calls[0]?.limit).toBe(3);
    const rest = exportEventPage(
      extra.reader,
      pageOptions(run.run_id, {
        after: seqs[1]!,
        through_seq: seqs[2]!,
        max_events: 2,
      }),
    );
    expect(rest).toMatchObject({
      ok: true,
      exported_count: 1,
      next_after: seqs[2],
      through_seq: seqs[2],
      has_more: false,
    });
    expect(sequences(rest)).toEqual([seqs[2]!]);
    expect(extra.watermarks()).toBe(1);
  });

  test("empty database and empty run do not invent events", () => {
    const empty = openStore();
    const emptyRun = makeRun(empty, "Empty database");
    const emptyProbe = counting(empty);
    expect(
      exportEventPage(emptyProbe.reader, pageOptions(emptyRun.run_id)),
    ).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: 0,
      through_seq: 0,
      has_more: false,
      details_omitted: true,
    });
    expect(emptyProbe.calls).toHaveLength(0);
    expect(emptyProbe.watermarks()).toBe(1);

    const store = openStore();
    const quiet = makeRun(store, "Quiet");
    const noisy = makeRun(store, "Noisy");
    store.event(noisy.run_id, "note", "elsewhere", null);
    store.event(null, "system", "global", null);
    const watermark = store.lastEventSeq();
    const probe = counting(store);
    const page = exportEventPage(probe.reader, pageOptions(quiet.run_id));
    expect(page).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: 0,
      through_seq: watermark,
      has_more: false,
      details_omitted: true,
    });
    expect(probe.calls).toEqual([
      { runId: quiet.run_id, after: 0, limit: 51 },
    ]);
  });

  test("a high or equal cursor is a terminal empty page without reading events", () => {
    const store = openStore();
    const run = makeRun(store, "Cursor");
    store.event(run.run_id, "note", "only", null);
    const watermark = store.lastEventSeq();
    const high = counting(store);
    const after = watermark + 25;
    expect(
      exportEventPage(high.reader, pageOptions(run.run_id, { after })),
    ).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: after,
      through_seq: watermark,
      has_more: false,
      details_omitted: true,
    });
    expect(high.calls).toHaveLength(0);
    expect(high.watermarks()).toBe(1);

    const equal = counting(store);
    expect(
      exportEventPage(
        equal.reader,
        pageOptions(run.run_id, { after: watermark }),
      ),
    ).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: watermark,
      through_seq: watermark,
      has_more: false,
      details_omitted: true,
    });
    expect(equal.calls).toHaveLength(0);

    const explicit = counting(store);
    expect(
      exportEventPage(
        explicit.reader,
        pageOptions(run.run_id, {
          after: watermark,
          through_seq: watermark,
        }),
      ),
    ).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: watermark,
      through_seq: watermark,
      has_more: false,
      details_omitted: true,
    });
    expect(explicit.calls).toHaveLength(0);
    expect(explicit.watermarks()).toBe(0);
  });

  test("rejects invalid options without reading", () => {
    const reader = sealedReader();
    const cases: unknown[] = [
      null,
      {},
      { run_id: "", after: 0, through_seq: null, max_events: 1, max_bytes: 1 },
      {
        run_id: "run",
        after: -1,
        through_seq: null,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 1.5,
        through_seq: null,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: Number.NaN,
        through_seq: null,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: Number.MAX_SAFE_INTEGER + 1,
        through_seq: null,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 5,
        through_seq: 4,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: -1,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: 1.2,
        max_events: 1,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: Number.MAX_SAFE_INTEGER + 1,
        max_events: 1,
        max_bytes: 1,
      },
      { run_id: "run", after: 0, max_events: 1, max_bytes: 1 },
      {
        run_id: "run",
        after: 0,
        through_seq: null,
        max_events: 0,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: null,
        max_events: 201,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: null,
        max_events: 1.5,
        max_bytes: 1,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: null,
        max_events: 1,
        max_bytes: 0,
      },
      {
        run_id: "run",
        after: 0,
        through_seq: null,
        max_events: 1,
        max_bytes: 262145,
      },
    ];
    for (const options of cases)
      expect(
        exportEventPage(reader, options as EventExportOptions),
      ).toEqual({ ok: false, code: "invalid_options" });

    const store = openStore();
    const run = makeRun(store, "Bounds");
    const probe = counting(store);
    expect(
      exportEventPage(
        probe.reader,
        pageOptions(run.run_id, { max_events: 200, max_bytes: 262144 }),
      ),
    ).toMatchObject({ ok: true, through_seq: 0, has_more: false });
    expect(probe.calls).toHaveLength(0);
  });

  test("a corrupt reader cannot contribute a partial page", () => {
    const runId = "run-a";
    const other = "run-b";
    const samples: Array<{
      events: ActivityEvent[];
      max_events: number;
      after: number;
    }> = [
        { events: [event(1, other), event(2, runId)], max_events: 10, after: 0 },
        { events: [event(1, runId), event(2, null)], max_events: 10, after: 0 },
        { events: [event(1, runId), event(1, runId)], max_events: 10, after: 0 },
        { events: [event(3, runId), event(2, runId)], max_events: 10, after: 0 },
        {
          events: [event(1, runId), event(2, runId), event(3, runId)],
          max_events: 1,
          after: 0,
        },
        { events: [event(4, runId)], max_events: 10, after: 4 },
        { events: [event(1, runId), event(2.5, runId)], max_events: 10, after: 0 },
      ];
    for (const sample of samples) {
      const reader: EventExportReader = {
        eventsAfter: () => sample.events,
        lastEventSeq: () => 100,
      };
      expect(
        exportEventPage(
          reader,
          pageOptions(runId, {
            after: sample.after,
            max_events: sample.max_events,
            through_seq: 100,
          }),
        ),
      ).toEqual({ ok: false, code: "invalid_reader_result" });
    }
    const badWatermarks = [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];
    for (const value of badWatermarks) {
      let reads = 0;
      const reader: EventExportReader = {
        eventsAfter() {
          reads += 1;
          return [];
        },
        lastEventSeq: () => value as number,
      };
      expect(
        exportEventPage(reader, pageOptions(runId, { through_seq: null })),
      ).toEqual({ ok: false, code: "invalid_reader_result" });
      expect(reads).toBe(0);
    }
  });

  test("keeps sequence gaps and ignores records above the watermark", () => {
    const runId = "run-a";
    const gapped = fixedReader([
      event(2, runId),
      event(5, runId),
      event(9, runId),
    ]);
    const gapPage = exportEventPage(
      gapped.reader,
      pageOptions(runId, { through_seq: 9, max_events: 10 }),
    );
    expect(sequences(gapPage)).toEqual([2, 5, 9]);
    expect(gapped.watermarks()).toBe(0);

    const mixed = fixedReader([
      event(1, runId, "in"),
      event(2, runId, "edge"),
      event(10, runId, "later"),
    ]);
    expect(
      exportEventPage(
        mixed.reader,
        pageOptions(runId, { through_seq: 2, max_events: 10 }),
      ),
    ).toMatchObject({
      exported_count: 2,
      next_after: 2,
      through_seq: 2,
      has_more: false,
    });
    expect(
      exportEventPage(
        mixed.reader,
        pageOptions(runId, { through_seq: 2, max_events: 1 }),
      ),
    ).toMatchObject({
      exported_count: 1,
      next_after: 1,
      has_more: true,
    });
    const suffix = fixedReader([event(1, runId), event(10, runId, "later")]);
    expect(
      exportEventPage(
        suffix.reader,
        pageOptions(runId, { through_seq: 2, max_events: 1 }),
      ),
    ).toMatchObject({
      exported_count: 1,
      next_after: 1,
      through_seq: 2,
      has_more: false,
    });
    const onlyLater = fixedReader([event(10, runId, "later")]);
    expect(
      exportEventPage(
        onlyLater.reader,
        pageOptions(runId, { after: 0, through_seq: 2 }),
      ),
    ).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: 0,
      through_seq: 2,
      has_more: false,
      details_omitted: true,
    });
  });

  test("byte budget keeps whole lines, including escapes and multibyte text", () => {
    const runId = "run-a";
    const summary = 'operator said "go"\nмодель: привет';
    const record = event(1, runId, summary, {
      secret: "hidden-secret-token",
      position: { x: 481516, y: 64, z: -1 },
    });
    const line = lineOf(record);
    const size = Buffer.byteLength(line, "utf8");
    expect(size).toBeGreaterThan(line.length);
    const fitted = fixedReader([record]);
    const exact = exportEventPage(
      fitted.reader,
      pageOptions(runId, { max_bytes: size, max_events: 5, through_seq: 10 }),
    );
    expect(exact).toMatchObject({
      ok: true,
      ndjson: line,
      exported_count: 1,
      next_after: 1,
      has_more: false,
      details_omitted: true,
    });
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "event_seq",
      "run_id",
      "at",
      "type",
      "summary",
    ]);
    expect(parsed.summary).toBe(summary);
    expect(line).not.toContain("hidden-secret-token");
    expect(line).not.toContain("481516");

    const short = exportEventPage(
      fitted.reader,
      pageOptions(runId, {
        max_bytes: size - 1,
        max_events: 5,
        through_seq: 10,
      }),
    );
    expect(short).toEqual({ ok: false, code: "record_too_large" });

    const first = event(4, runId, "alpha");
    const retained = event(7, runId, "bravo holds");
    const skipped = event(8, runId, "charlie");
    const firstLine = lineOf(first);
    const retainedLine = lineOf(retained);
    const skippedLine = lineOf(skipped);
    const budget =
      Buffer.byteLength(firstLine, "utf8") +
      Buffer.byteLength(retainedLine, "utf8") -
      1;
    const reader = fixedReader([first, retained, skipped], 20);
    const partial = exportEventPage(
      reader.reader,
      pageOptions(runId, { max_bytes: budget, max_events: 10, through_seq: 20 }),
    );
    expect(partial).toEqual({
      ok: true,
      ndjson: firstLine,
      exported_count: 1,
      next_after: 4,
      through_seq: 20,
      has_more: true,
      details_omitted: true,
    });
    if (partial.ok) expect(partial.ndjson).not.toContain("charlie");
    const continued = exportEventPage(
      reader.reader,
      pageOptions(runId, {
        after: 4,
        through_seq: 20,
        max_bytes: 262144,
        max_events: 10,
      }),
    );
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.ndjson.startsWith(retainedLine)).toBe(true);
    expect(sequences(continued)).toEqual([7, 8]);
    expect(reader.watermarks()).toBe(0);
    expect(reader.calls.map((call) => call.after)).toEqual([0, 4]);

    const huge = event(1, runId, "я".repeat(50));
    const small = event(2, runId, "ok");
    const smallLine = lineOf(small);
    const blocked = exportEventPage(
      fixedReader([huge, small]).reader,
      pageOptions(runId, {
        max_bytes: Buffer.byteLength(smallLine, "utf8"),
        max_events: 10,
        through_seq: 5,
      }),
    );
    expect(blocked).toEqual({ ok: false, code: "record_too_large" });
    expect(Buffer.byteLength(lineOf(huge), "utf8")).toBeGreaterThan(
      Buffer.byteLength(smallLine, "utf8"),
    );
  });

  test("projection omits details without redacting summary", () => {
    const runId = "run-a";
    let detailsReads = 0;
    const source = event(3, runId, "operator marker stays", {
      secret: "hidden-secret-token",
      position: { x: 481516, y: 1, z: 2 },
    });
    Object.defineProperty(source, "details", {
      enumerable: true,
      get() {
        detailsReads += 1;
        throw new Error("details accessed");
      },
    });
    const page = exportEventPage(
      fixedReader([source]).reader,
      pageOptions(runId, { through_seq: 3, max_events: 5 }),
    );
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const parsed = JSON.parse(page.ndjson.trim()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "event_seq",
      "run_id",
      "at",
      "type",
      "summary",
    ]);
    expect(parsed.summary).toBe("operator marker stays");
    expect(page.ndjson).not.toContain("hidden-secret-token");
    expect(page.ndjson).not.toContain("481516");
    expect(detailsReads).toBe(0);
    expect(page.details_omitted).toBe(true);
  });

  test("a supplied through_seq is the bound and is not refreshed", () => {
    const runId = "run-a";
    const ceiling = fixedReader(
      [event(1, runId), event(2, runId), event(3, runId)],
      1,
    );
    const page = exportEventPage(
      ceiling.reader,
      pageOptions(runId, { through_seq: 3, max_events: 10 }),
    );
    expect(sequences(page)).toEqual([1, 2, 3]);
    expect(page).toMatchObject({ through_seq: 3, has_more: false });
    expect(ceiling.watermarks()).toBe(0);

    const above = fixedReader(
      [event(1, runId, "in"), event(4, runId, "later")],
      99,
    );
    expect(
      exportEventPage(
        above.reader,
        pageOptions(runId, { through_seq: 2, max_events: 10 }),
      ),
    ).toMatchObject({
      exported_count: 1,
      next_after: 1,
      through_seq: 2,
      has_more: false,
    });
    expect(above.watermarks()).toBe(0);
  });

  test("run_id is forwarded unchanged, including a long value", () => {
    const runId = `  ${"r".repeat(300)}`;
    const row = event(1, runId, "model said go north");
    row.at = "t".repeat(80);
    row.type = `note-${"x".repeat(300)}`;
    const line = lineOf(row);
    const seen: { id: string | null } = { id: null };
    const page = exportEventPage(
      {
        eventsAfter(id, after, limit) {
          seen.id = id;
          expect(after).toBe(0);
          expect(limit).toBe(2);
          return [row];
        },
        lastEventSeq() {
          throw new Error("watermark");
        },
      },
      pageOptions(runId, {
        through_seq: 1,
        max_events: 1,
        max_bytes: Buffer.byteLength(line, "utf8"),
      }),
    );
    expect(seen.id).toBe(runId);
    expect(page).toMatchObject({
      ok: true,
      ndjson: line,
      exported_count: 1,
      through_seq: 1,
      has_more: false,
    });
  });

  test("reader failures become invalid_reader_result", () => {
    const runId = "run-a";
    const throwingEvents: EventExportReader = {
      eventsAfter() {
        throw new Error("database is locked");
      },
      lastEventSeq: () => 10,
    };
    expect(exportEventPage(throwingEvents, pageOptions(runId))).toEqual({
      ok: false,
      code: "invalid_reader_result",
    });

    let reads = 0;
    const throwingWatermark: EventExportReader = {
      eventsAfter() {
        reads += 1;
        return [];
      },
      lastEventSeq() {
        throw new Error("database is locked");
      },
    };
    expect(exportEventPage(throwingWatermark, pageOptions(runId))).toEqual({
      ok: false,
      code: "invalid_reader_result",
    });
    expect(reads).toBe(0);
    expect(
      exportEventPage(
        throwingWatermark,
        pageOptions(runId, { through_seq: 5 }),
      ),
    ).toEqual({
      ok: true,
      ndjson: "",
      exported_count: 0,
      next_after: 0,
      through_seq: 5,
      has_more: false,
      details_omitted: true,
    });
    expect(reads).toBe(1);

    for (const value of [[], "rows", null, { length: 0 }]) {
      const reader: EventExportReader = {
        eventsAfter: () => value as unknown as ActivityEvent[],
        lastEventSeq: () => 10,
      };
      const result = exportEventPage(reader, pageOptions(runId));
      if (Array.isArray(value)) expect(result.ok).toBe(true);
      else
        expect(result).toEqual({ ok: false, code: "invalid_reader_result" });
    }

    const fields = ["event_seq", "run_id", "at", "type", "summary"] as const;
    for (const field of fields) {
      const row = event(1, runId);
      Object.defineProperty(row, field, {
        enumerable: true,
        get() {
          throw new Error(`${field} boom`);
        },
      });
      let result: EventExportResult | undefined;
      expect(() => {
        result = exportEventPage(
          { eventsAfter: () => [row], lastEventSeq: () => 5 },
          pageOptions(runId, { through_seq: 5 }),
        );
      }).not.toThrow();
      expect(result).toEqual({ ok: false, code: "invalid_reader_result" });
    }

    const good = event(1, runId, "keep");
    const bad = event(2, runId, "later");
    Object.defineProperty(bad, "summary", {
      enumerable: true,
      get() {
        throw new Error("summary boom");
      },
    });
    expect(
      exportEventPage(
        { eventsAfter: () => [good, bad], lastEventSeq: () => 5 },
        pageOptions(runId, { through_seq: 5, max_bytes: 262144 }),
      ),
    ).toEqual({ ok: false, code: "invalid_reader_result" });

    const rows = new Proxy([event(1, runId)], {
      get(target, prop, receiver) {
        if (prop === "length") throw new Error("length boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(
      exportEventPage(
        { eventsAfter: () => rows, lastEventSeq: () => 5 },
        pageOptions(runId, { through_seq: 5 }),
      ),
    ).toEqual({ ok: false, code: "invalid_reader_result" });
  });
});
