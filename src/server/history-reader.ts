import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { HISTORY_LIMITS } from "./history-limits.ts";
import {
  historyQuerySchema,
  type HistoryQuery,
  type HistoryQueryClient,
  type HistoryQueryOptions,
  type HistoryResult,
} from "./history-protocol.ts";
import type { StoreReadLocation } from "./store-read.ts";
import { RuntimeFault } from "./runtime-fault.ts";

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ok: z.literal(true), value: z.json() }).strict(),
  z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ok: z.literal(false),
    error: z.object({ code: z.string().min(1).max(80), message: z.string().max(1024) }).strict() }).strict(),
]);
const workerPath = fileURLToPath(new URL("./history-worker.ts", import.meta.url));
const maximumTimerMs = 2_147_483_647;
// Only these query-domain faults are safe to expose as model-visible failures.
// Process, protocol, SQLite, readonly-schema and filesystem errors stay infrastructure.
const domainFaultCodes: ReadonlySet<string> = new Set([
  "not_found", "invalid_request", "conflict", "forbidden", "budget_exceeded",
]);

export class HistoryReaderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HistoryReaderError";
  }
}

interface PendingQuery {
  id: number;
  query: HistoryQuery;
  line: string;
  deadline: number;
  signal?: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface OwnedChild {
  process: ChildProcess;
  lifecycle: HistoryChildSnapshot;
  drained: Promise<void>;
  finishDrain: () => void;
  stopping: boolean;
  failure: Error | null;
  rejectQueued: boolean;
  bytes: number;
  parts: Buffer[];
}
export interface HistoryChildSnapshot {
  pid: number | null;
  startedHostMs: number;
  exitObservedHostMs: number | null;
  stdoutDrainObservedHostMs: number | null;
  closedHostMs: number | null;
}
export interface HistoryReaderSnapshot {
  closed: boolean;
  active: boolean;
  queued: number;
  child: HistoryChildSnapshot | null;
}

/** One owned, readonly query process; this facade never opens the database. */
export class HistoryReader implements HistoryQueryClient {
  readonly #location: Readonly<StoreReadLocation>;
  #child: OwnedChild | null = null;
  #active: PendingQuery | null = null;
  #queue: PendingQuery[] = [];
  #nextId = 1;
  #closed = false;
  #closing: Promise<void> | null = null;
  #latestLifecycle: HistoryChildSnapshot | null = null;

  constructor(location: StoreReadLocation) {
    if (!location || typeof location.database !== "string" || !location.database ||
      typeof location.artifacts !== "string" || !location.artifacts ||
      location.database.includes("\0") || location.artifacts.includes("\0") ||
      (location.projection !== undefined && (typeof location.projection !== "string" || !location.projection || location.projection.includes("\0"))))
      throw new HistoryReaderError("invalid_location", "History requires fixed database and artifact locations");
    this.#location = Object.freeze({ database: path.resolve(location.database), artifacts: path.resolve(location.artifacts),
      ...(location.projection === undefined ? {} : { projection: path.resolve(location.projection) }) });
  }

  snapshot(): HistoryReaderSnapshot {
    return {
      closed: this.#closed, active: this.#active !== null, queued: this.#queue.length,
      child: this.#latestLifecycle ? { ...this.#latestLifecycle } : null,
    };
  }

  query<Q extends HistoryQuery>(query: Q, options: HistoryQueryOptions): Promise<HistoryResult<Q>> {
    try {
      if (this.#closed) throw new HistoryReaderError("closed", "History reader is closed");
      const parsed = historyQuerySchema.safeParse(query);
      if (!parsed.success) throw new HistoryReaderError("invalid_query", "Invalid history query");
      if (!options || !Number.isFinite(options.deadlineHostMs))
        throw new HistoryReaderError("invalid_deadline", "History requires a finite absolute host deadline");
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
        throw new HistoryReaderError("invalid_signal", "History requires an AbortSignal");
      if (options.signal?.aborted) throw new HistoryReaderError("aborted", "History query was aborted");
      if (options.deadlineHostMs <= performance.now()) throw new HistoryReaderError("deadline", "History query deadline expired");
      if (this.#queue.length >= HISTORY_LIMITS.queued)
        throw new HistoryReaderError("queue_full", "History query queue is full");
      if (!Number.isSafeInteger(this.#nextId)) throw new HistoryReaderError("request_ids_exhausted", "History request identifiers exhausted");
      const id = this.#nextId++;
      const line = JSON.stringify({ id, query: parsed.data }) + "\n";
      if (Buffer.byteLength(line, "utf8") > HISTORY_LIMITS.requestBytes)
        throw new HistoryReaderError("request_too_large", "History request exceeds its wire budget");
      const completion = Promise.withResolvers<HistoryResult<Q>>();
      const pending: PendingQuery = {
        id, query: parsed.data, line, deadline: options.deadlineHostMs, signal: options.signal,
        abort: () => this.#cancel(pending, new HistoryReaderError("aborted", "History query was aborted")),
        resolve: value => completion.resolve(value as HistoryResult<Q>), reject: completion.reject,
      };
      this.#queue.push(pending);
      pending.signal?.addEventListener("abort", pending.abort, { once: true });
      this.#armDeadline(pending);
      // Handle an abort between validation and listener installation, too.
      if (pending.signal?.aborted) pending.abort();
      this.#pump();
      return completion.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  cancelRun(runId: string): Promise<void> {
    const error = new HistoryReaderError("cancelled", "History queries for this run were cancelled");
    for (const pending of [...this.#queue]) if (pending.query.run_id === runId) this.#cancel(pending, error);
    if (this.#active?.query.run_id === runId && this.#child) {
      const child = this.#child;
      this.#stop(child, error, false);
      return child.drained;
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const error = new HistoryReaderError("closed", "History reader is closed");
    const child = this.#child;
    for (const pending of this.#queue) this.#cleanup(pending);
    if (child) this.#stop(child, error, true);
    else this.#rejectQueue(error);
    this.#closing = child ? child.drained : Promise.resolve();
    return this.#closing;
  }

  #armDeadline(pending: PendingQuery): void {
    pending.timer = setTimeout(() => {
      if (performance.now() < pending.deadline) this.#armDeadline(pending);
      else this.#cancel(pending, new HistoryReaderError("deadline", "History query deadline expired"));
    }, Math.max(1, Math.min(maximumTimerMs, pending.deadline - performance.now())));
  }

  #cleanup(pending: PendingQuery): void {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
  }

  #cancel(pending: PendingQuery, error: Error): void {
    if (this.#active === pending) {
      if (this.#child) this.#stop(this.#child, error, false);
      return;
    }
    const index = this.#queue.indexOf(pending);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#cleanup(pending);
    pending.reject(error);
  }

  #rejectQueue(error: Error): void {
    const queued = this.#queue.splice(0);
    for (const pending of queued) {
      this.#cleanup(pending);
      pending.reject(error);
    }
  }

  #pump(): void {
    if (this.#closed || this.#active || this.#child?.stopping || !this.#queue.length) return;
    const pending = this.#queue.shift()!;
    if (pending.signal?.aborted || performance.now() >= pending.deadline) {
      this.#cleanup(pending);
      pending.reject(new HistoryReaderError(pending.signal?.aborted ? "aborted" : "deadline", "History query cancelled before dispatch"));
      queueMicrotask(() => this.#pump());
      return;
    }
    this.#active = pending;
    try {
      const child = this.#child ?? this.#start();
      child.process.stdin!.write(pending.line, error => {
        if (error && !child.stopping) this.#stop(child, new HistoryReaderError("worker_io", "History request pipe failed"), true);
      });
    } catch {
      if (this.#child) this.#stop(this.#child, new HistoryReaderError("worker_start", "History worker could not start"), true);
      else {
        this.#active = null;
        this.#cleanup(pending);
        const error = new HistoryReaderError("worker_start", "History worker could not start");
        pending.reject(error);
        this.#rejectQueue(error);
      }
    }
  }

  #start(): OwnedChild {
    const processChild = spawn(process.execPath, ["--no-env-file", workerPath, this.#location.database, this.#location.artifacts,
      ...(this.#location.projection === undefined ? [] : [this.#location.projection])], {
      cwd: path.dirname(workerPath),
      // No inherited HOME, credential, proxy, NODE_OPTIONS, BUN_OPTIONS or preload configuration.
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const closure = Promise.withResolvers<void>();
    const lifecycle: HistoryChildSnapshot = {
      pid: processChild.pid ?? null, startedHostMs: performance.now(),
      exitObservedHostMs: null, stdoutDrainObservedHostMs: null, closedHostMs: null,
    };
    this.#latestLifecycle = lifecycle;
    const child: OwnedChild = {
      process: processChild, lifecycle, drained: closure.promise, finishDrain: closure.resolve, stopping: false, failure: null,
      rejectQueued: false, bytes: 0, parts: [],
    };
    this.#child = child;
    processChild.stdout!.on("data", (data: Buffer) => this.#read(child, data));
    processChild.stdout!.on("error", () => {
      if (!child.stopping) this.#stop(child, new HistoryReaderError("worker_io", "History response pipe failed"), true);
    });
    processChild.stdin!.on("error", () => {
      if (!child.stopping) this.#stop(child, new HistoryReaderError("worker_io", "History request pipe failed"), true);
    });
    processChild.on("error", () => this.#stop(child, new HistoryReaderError("worker_start", "History worker process failed"), true));
    processChild.once("exit", () => {
      lifecycle.exitObservedHostMs = performance.now();
      if (!child.stopping) this.#stop(child, new HistoryReaderError("worker_exit", "History worker exited unexpectedly"), true);
    });
    const stdoutDrained = () => {
      lifecycle.stdoutDrainObservedHostMs ??= performance.now();
      if (!child.stopping) this.#stop(child, new HistoryReaderError("worker_eof", "History response stream ended unexpectedly"), true);
    };
    processChild.stdout!.once("end", stdoutDrained);
    processChild.stdout!.once("close", stdoutDrained);
    // Node's close event follows process exit AND closure of the owned stdio pipes.
    // Keep consuming stdout after kill; no cancellation promise races this barrier.
    processChild.once("close", () => {
      child.stopping = true;
      // Node can emit the child's close from its own stdout-close listener.
      // Let the remaining stdout observers run before publishing our barrier.
      queueMicrotask(() => {
        lifecycle.closedHostMs = performance.now();
        const error = child.failure ?? new HistoryReaderError("worker_exit", "History worker exited before reader closure");
        child.parts = [];
        child.bytes = 0;
        if (this.#child === child) {
          this.#child = null;
          const pending = this.#active;
          this.#active = null;
          if (pending) {
            this.#cleanup(pending);
            pending.reject(error);
          }
          if (child.rejectQueued || !child.failure || this.#closed) {
            // Queued requests were never dispatched: the active query's domain
            // result is not evidence about them, and they are never retried.
            this.#rejectQueue(error instanceof RuntimeFault
              ? new HistoryReaderError("worker_exit", "History worker stopped before queued query dispatch")
              : error);
          }
        }
        child.finishDrain();
        queueMicrotask(() => this.#pump());
      });
    });
    return child;
  }

  #stop(child: OwnedChild, error: Error, rejectQueued: boolean): void {
    child.failure ??= error;
    child.rejectQueued ||= rejectQueued;
    if (child.stopping) return;
    child.stopping = true;
    child.parts = [];
    child.bytes = 0;
    // SIGKILL is deliberate: SQLite/reducers are synchronous and cannot service IPC cancellation.
    try { child.process.kill("SIGKILL"); } catch { /* The close event still owns settlement. */ }
  }

  #read(child: OwnedChild, chunk: Buffer): void {
    if (child.stopping) return; // Drain without retaining output from the terminating process.
    let offset = 0;
    let completed: { pending: PendingQuery; frame: z.infer<typeof responseSchema> } | null = null;
    try {
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const through = end < 0 ? chunk.length : end + 1;
        const length = through - offset;
        if (child.bytes + length > HISTORY_LIMITS.responseBytes)
          throw new HistoryReaderError("response_too_large", "History response exceeds its wire budget");
        // Copy only bounded bytes; retaining a slice must not retain an arbitrary backing chunk.
        child.parts.push(Buffer.from(chunk.subarray(offset, through)));
        child.bytes += length;
        offset = through;
        if (end < 0) break;
        if (completed) throw new HistoryReaderError("protocol", "History worker sent multiple response frames");
        const bytes = Buffer.concat(child.parts, child.bytes);
        child.parts = [];
        child.bytes = 0;
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 1));
        const frame = responseSchema.parse(JSON.parse(line));
        if (frame.ok && !Object.hasOwn(frame, "value")) throw new HistoryReaderError("protocol", "History response has no value");
        const pending = this.#active;
        if (!pending || frame.id !== pending.id) throw new HistoryReaderError("protocol", "History response identifier mismatch");
        completed = { pending, frame };
      }
      if (!completed) return;
      if (child.bytes) throw new HistoryReaderError("protocol", "History worker sent unsolicited trailing bytes");
      const { pending, frame } = completed;
      if (pending.signal?.aborted || performance.now() >= pending.deadline) {
        this.#stop(child, new HistoryReaderError(pending.signal?.aborted ? "aborted" : "deadline", "History query cancelled before response"), false);
        return;
      }
      if (!frame.ok) {
        const error = domainFaultCodes.has(frame.error.code)
          ? new RuntimeFault(frame.error.code, frame.error.message)
          : new HistoryReaderError(frame.error.code, "History worker query failed");
        this.#stop(child, error, true);
        return;
      }
      this.#active = null;
      this.#cleanup(pending);
      pending.resolve(frame.value);
      queueMicrotask(() => this.#pump());
    } catch (error) {
      this.#stop(child, error instanceof HistoryReaderError ? error : new HistoryReaderError("protocol", "History worker returned an invalid response"), true);
    }
  }
}
