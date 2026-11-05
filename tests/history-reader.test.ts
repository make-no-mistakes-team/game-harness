import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryReader, type HistoryReaderSnapshot } from "../src/server/history-reader.ts";
import { HISTORY_LIMITS } from "../src/server/history-limits.ts";
import type { HistoryExportCursor, HistoryExportPage, HistoryQuery } from "../src/server/history-protocol.ts";
import { historyFixture, type HistoryFixture } from "./helpers/history-fixture.ts";

const fixtures: HistoryFixture[] = [];
const readers: HistoryReader[] = [];
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const fixture = historyFixture();
  fixtures.push(fixture);
  const reader = new HistoryReader(fixture.store.readLocation());
  readers.push(reader);
  const query: HistoryQuery = { kind: "operator_deaths", run_id: fixture.run.run_id, after: 0, limit: 10 };
  return { ...fixture, reader, query };
}
function options(signal?: AbortSignal) { return { deadlineHostMs: performance.now() + 15_000, signal }; }
function capture<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    value => ({ status: "fulfilled", value }),
    reason => ({ status: "rejected", reason }),
  );
}
function stopChild(reader: HistoryReader) {
  const pid = reader.snapshot().child!.pid!;
  process.kill(pid, "SIGSTOP");
  return pid;
}
function closureObserved(snapshot: HistoryReaderSnapshot) {
  expect(snapshot.child?.pid).toBeNumber();
  expect(snapshot.child?.exitObservedHostMs).toBeNumber();
  expect(snapshot.child?.stdoutDrainObservedHostMs).toBeNumber();
  expect(snapshot.child?.closedHostMs).toBeNumber();
  expect(snapshot.child!.closedHostMs!).toBeGreaterThanOrEqual(snapshot.child!.exitObservedHostMs!);
  expect(snapshot.child!.closedHostMs!).toBeGreaterThanOrEqual(snapshot.child!.stdoutDrainObservedHostMs!);
}
function digest(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

test("real worker is lazy, reuses one readonly child, and returns detached values", async () => {
  const { reader, query, store } = setup();
  expect(reader.snapshot()).toEqual({ closed: false, active: false, queued: 0, child: null });
  store.close();
  const database = store.readLocation().database;
  const before = digest(database);
  const first = await reader.query(query, options());
  const pid = reader.snapshot().child!.pid;
  expect(first).toEqual({ episodes: [], next_after: 0, has_more: false });
  first.next_after = 999;
  expect(await reader.query(query, options())).toEqual({ episodes: [], next_after: 0, has_more: false });
  expect(reader.snapshot().child!.pid).toBe(pid);
  expect(reader.snapshot().child!.closedHostMs).toBeNull();
  await reader.close();
  closureObserved(reader.snapshot());
  expect(digest(database)).toBe(before);
});

test("strict validation, finite host deadlines and pre-aborted queries do not launch a child", async () => {
  const { reader, query } = setup();
  const extra = { ...query, arbitrary_sql: "SELECT 1" };
  await expect(reader.query(extra, options())).rejects.toMatchObject({ code: "invalid_query" });
  await expect(reader.query(query, { deadlineHostMs: Infinity })).rejects.toMatchObject({ code: "invalid_deadline" });
  await expect(reader.query(query, { deadlineHostMs: NaN })).rejects.toMatchObject({ code: "invalid_deadline" });
  await expect(reader.query(query, { deadlineHostMs: performance.now() - 1 })).rejects.toMatchObject({ code: "deadline" });
  const controller = new AbortController();
  controller.abort();
  await expect(reader.query(query, options(controller.signal))).rejects.toMatchObject({ code: "aborted" });
  expect(reader.snapshot().child).toBeNull();
});

test("one active plus eight accepted FIFO entries, with explicit overflow", async () => {
  const { reader, query } = setup();
  const completed: number[] = [];
  const queries = Array.from({ length: HISTORY_LIMITS.queued + 1 }, (_, index) =>
    capture(reader.query(query, options())).then(result => {
      if (result.status === "fulfilled") completed.push(index);
      return result;
    }));
  expect(reader.snapshot()).toMatchObject({ active: true, queued: 8 });
  await expect(reader.query(query, options())).rejects.toMatchObject({ code: "queue_full" });
  expect((await Promise.all(queries)).map(result => result.status)).toEqual(Array(9).fill("fulfilled"));
  expect(completed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test.skipIf(process.platform === "win32")("queued abort does not terminate the unrelated active owner", async () => {
  const { reader, query } = setup();
  const first = capture(reader.query(query, options()));
  const pid = stopChild(reader);
  const controller = new AbortController();
  const second = capture(reader.query(query, options(controller.signal)));
  controller.abort();
  expect(await second).toMatchObject({ status: "rejected", reason: { code: "aborted" } });
  expect(reader.snapshot()).toMatchObject({ active: true, queued: 0, child: { pid, closedHostMs: null } });
  process.kill(pid, "SIGCONT");
  expect(await first).toMatchObject({ status: "fulfilled", value: { episodes: [] } });
  expect(reader.snapshot().child).toMatchObject({ pid, closedHostMs: null });
});

test.skipIf(process.platform === "win32")("active abort settles only after actual exit and stdout drain, then an explicit query starts a fresh owner", async () => {
  const { reader, query } = setup();
  const controller = new AbortController();
  const pending = capture(reader.query(query, options(controller.signal)));
  const pid = stopChild(reader);
  controller.abort();
  expect(reader.snapshot().child!.closedHostMs).toBeNull();
  expect(await pending).toMatchObject({ status: "rejected", reason: { code: "aborted" } });
  closureObserved(reader.snapshot());
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await reader.query(query, options())).toMatchObject({ episodes: [] });
  expect(reader.snapshot().child!.pid).not.toBe(pid);
});

test.skipIf(process.platform === "win32")("active absolute deadline kills even a stopped child and waits its closure", async () => {
  const { reader, query } = setup();
  const pending = capture(reader.query(query, { deadlineHostMs: performance.now() + 100 }));
  const pid = stopChild(reader);
  expect(await pending).toMatchObject({ status: "rejected", reason: { code: "deadline" } });
  closureObserved(reader.snapshot());
  expect(() => process.kill(pid, 0)).toThrow();
});

test.skipIf(process.platform === "win32")("queued absolute deadline leaves the stopped active owner untouched", async () => {
  const { reader, query } = setup();
  const first = capture(reader.query(query, options()));
  const pid = stopChild(reader);
  const queued = capture(reader.query(query, { deadlineHostMs: performance.now() + 25 }));
  expect(await queued).toMatchObject({ status: "rejected", reason: { code: "deadline" } });
  expect(reader.snapshot()).toMatchObject({ active: true, queued: 0, child: { pid, closedHostMs: null } });
  process.kill(pid, "SIGCONT");
  expect(await first).toMatchObject({ status: "fulfilled", value: { episodes: [] } });
});

test.skipIf(process.platform === "win32")("cancelRun of queued work does not terminate another run's active owner", async () => {
  const { reader, query } = setup();
  const first = capture(reader.query(query, options()));
  const pid = stopChild(reader);
  const queued = capture(reader.query({ ...query, run_id: "cancelled-queued-run" }, options()));
  await reader.cancelRun("cancelled-queued-run");
  expect(await queued).toMatchObject({ status: "rejected", reason: { code: "cancelled" } });
  expect(reader.snapshot()).toMatchObject({ active: true, queued: 0, child: { pid, closedHostMs: null } });
  process.kill(pid, "SIGCONT");
  expect(await first).toMatchObject({ status: "fulfilled", value: { episodes: [] } });
  expect(reader.snapshot().child).toMatchObject({ pid, closedHostMs: null });
});

test.skipIf(process.platform === "win32")("cancelRun removes only its queued run and waits its active child closure", async () => {
  const { reader, query, run, store } = setup();
  store.saveRun({ ...run, run_id: "unrelated-run" });
  const first = capture(reader.query(query, options()));
  const pid = stopChild(reader);
  const second = capture(reader.query(query, options()));
  const third = capture(reader.query({ ...query, run_id: "unrelated-run" }, options()));
  const closed = reader.cancelRun(run.run_id).then(() => reader.snapshot());
  expect(reader.snapshot()).toMatchObject({ active: true, queued: 1, child: { pid, closedHostMs: null } });
  const [firstResult, secondResult, closedSnapshot] = await Promise.all([first, second, closed]);
  expect(firstResult).toMatchObject({ status: "rejected", reason: { code: "cancelled" } });
  expect(secondResult).toMatchObject({ status: "rejected", reason: { code: "cancelled" } });
  closureObserved(closedSnapshot);
  expect(closedSnapshot.child!.pid).toBe(pid);
  expect(() => process.kill(pid, 0)).toThrow();
  // The unrelated request was not retried: it was still queued until the old owner drained.
  expect(await third).toMatchObject({ status: "fulfilled", value: { episodes: [] } });
  expect(reader.snapshot().child!.pid).not.toBe(pid);
  expect(reader.snapshot().child!.startedHostMs).toBeGreaterThanOrEqual(closedSnapshot.child!.closedHostMs!);
});

test("structured query faults retire the owner before rejecting and do not become empty evidence", async () => {
  const { reader, query } = setup();
  const failed = capture(reader.query({ ...query, run_id: "missing-run" }, options()));
  const queued = capture(reader.query(query, options()));
  const results = await Promise.all([failed, queued]);
  expect(results).toMatchObject([
    { status: "rejected", reason: { code: "not_found" } },
    { status: "rejected", reason: { code: "worker_exit" } },
  ]);
  closureObserved(reader.snapshot());
  expect(await reader.query(query, options())).toMatchObject({ episodes: [] });
});

test.skipIf(process.platform === "win32")("idempotent close waits active exit and drains every accepted queue rejection", async () => {
  const { reader, query } = setup();
  const first = capture(reader.query(query, options()));
  const pid = stopChild(reader);
  const accepted = [first, capture(reader.query(query, options())), capture(reader.query(query, options()))];
  const close = reader.close();
  expect(reader.close()).toBe(close);
  await close;
  for (const result of await Promise.all(accepted))
    expect(result).toMatchObject({ status: "rejected", reason: { code: "closed" } });
  expect(reader.snapshot()).toMatchObject({ closed: true, active: false, queued: 0 });
  closureObserved(reader.snapshot());
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(reader.query(query, options())).rejects.toMatchObject({ code: "closed" });
});

test("worker opening faults are explicit and settle queued work only after pipe closure", async () => {
  const fixture = setup();
  const location = fixture.store.readLocation();
  const missing = join(fixture.directory, "missing.sqlite");
  const reader = new HistoryReader({ ...location, database: missing });
  readers.push(reader);
  const requests = [capture(reader.query(fixture.query, options())), capture(reader.query(fixture.query, options()))];
  const results = await Promise.all(requests);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  closureObserved(reader.snapshot());
  expect(existsSync(missing)).toBe(false);
});

async function rawWorker(fixture: HistoryFixture, input: Buffer) {
  const location = fixture.store.readLocation();
  const child = spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("../src/server/history-worker.ts", import.meta.url)),
    location.database, location.artifacts], { stdio: ["pipe", "pipe", "ignore"], env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" } });
  const closed = Promise.withResolvers<number | null>();
  const output: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
  child.stdin!.on("error", () => {});
  child.on("error", closed.reject);
  child.once("close", code => closed.resolve(code));
  child.stdin!.end(input);
  return { code: await closed.promise, output: Buffer.concat(output) };
}

test("fixed worker accepts one strict UTF-8 line and closes readonly storage on normal EOF", async () => {
  const fixture = setup();
  fixture.store.close();
  const before = digest(fixture.store.readLocation().database);
  const response = await rawWorker(fixture, Buffer.from(JSON.stringify({ id: 1, query: fixture.query }) + "\n"));
  expect(response.code).toBe(0);
  expect(response.output.length).toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
  expect(JSON.parse(response.output.toString("utf8"))).toEqual({ id: 1, ok: true, value: { episodes: [], next_after: 0, has_more: false } });
  expect(digest(fixture.store.readLocation().database)).toBe(before);
});

test("fixed worker rejects malformed, unknown, invalid UTF-8 and oversized whole request frames", async () => {
  const fixture = setup();
  for (const input of [
    Buffer.from("{\n"),
    Buffer.from(JSON.stringify({ id: 1, query: { kind: "arbitrary_sql", sql: "SELECT 1" } }) + "\n"),
    Buffer.from([0xff, 0x0a]),
    Buffer.from(" ".repeat(HISTORY_LIMITS.requestBytes) + "\n"),
    Buffer.from(JSON.stringify({ id: 1, query: fixture.query })),
  ]) {
    const response = await rawWorker(fixture, input);
    expect(response.code).not.toBe(0);
    expect(response.output.length).toBe(0);
  }
});

test("fixed worker request budget counts the entire envelope and its newline", async () => {
  const fixture = setup();
  const json = JSON.stringify({ id: 1, query: fixture.query });
  const exact = Buffer.from(json + " ".repeat(HISTORY_LIMITS.requestBytes - Buffer.byteLength(json) - 1) + "\n");
  expect(exact.length).toBe(HISTORY_LIMITS.requestBytes);
  const accepted = await rawWorker(fixture, exact);
  expect(accepted.code).toBe(0);
  expect(JSON.parse(accepted.output.toString("utf8"))).toMatchObject({ id: 1, ok: true });
  const rejected = await rawWorker(fixture, Buffer.concat([exact.subarray(0, exact.length - 1), Buffer.from(" \n")]));
  expect(rejected.code).not.toBe(0);
  expect(rejected.output.length).toBe(0);
});

test("real worker reconstructs oversized UTF-8 archives from bounded pages and closes every EOF", async () => {
  const fixture = setup();
  const task = "界😀".repeat(HISTORY_LIMITS.responseBytes);
  fixture.store.saveRun({ ...fixture.run, task });
  fixture.store.close();
  const before = digest(fixture.store.readLocation().database);
  const chunks: { text: string; sha256: string; original_bytes: number; chunk_count: number }[] = [];
  let after: HistoryExportCursor = { record_index: 0, chunk_index: 0 };
  let pages = 0;
  do {
    const query: HistoryQuery = { kind: "export_page", run_id: fixture.run.run_id, collection: "run", after, limit: 10 };
    const response = await rawWorker(fixture, Buffer.from(JSON.stringify({ id: 1, query }) + "\n"));
    expect(response.code).toBe(0);
    expect(response.output.length).toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
    expect(response.output.at(-1)).toBe(10);
    const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.output));
    expect(frame).toMatchObject({ id: 1, ok: true, value: { omissions: [] } });
    const page: HistoryExportPage = frame.value;
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.records.length).toBeLessThanOrEqual(query.limit);
    expect(page.total).toBe(1);
    const progress = page.next_after.record_index - after.record_index || page.next_after.chunk_index - after.chunk_index;
    expect(progress).toBeGreaterThan(0);
    for (const [index, record] of page.records.entries()) {
      const chunk = record as { text: string; sha256: string; original_bytes: number; chunk_count: number };
      expect(chunk).toMatchObject({ kind: "json_record_chunk", collection: "run", record_index: 0,
        record_count: 1, chunk_index: after.chunk_index + index, encoding: "json_text" });
      chunks.push(chunk);
    }
    after = page.next_after;
    pages++;
    expect(after.record_index).toBeLessThanOrEqual(page.total);
    if (!page.has_more) {
      expect(after).toEqual({ record_index: page.total, chunk_index: 0 });
      break;
    }
    expect(after.record_index).toBe(0);
    expect(after.chunk_index).toBe(chunks.length);
  } while (true);
  expect(pages).toBeGreaterThan(1);
  const encoded = chunks.map(chunk => chunk.text).join("");
  const hash = createHash("sha256").update(encoded, "utf8").digest("hex");
  const bytes = Buffer.byteLength(encoded, "utf8");
  for (const chunk of chunks)
    expect(chunk).toMatchObject({ sha256: hash, original_bytes: bytes, chunk_count: chunks.length });
  expect(JSON.parse(encoded)).toMatchObject({ run_id: fixture.run.run_id, task });
  expect(bytes).toBeGreaterThan(HISTORY_LIMITS.responseBytes);
  expect(digest(fixture.store.readLocation().database)).toBe(before);
});
