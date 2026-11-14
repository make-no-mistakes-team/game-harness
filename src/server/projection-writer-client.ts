import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { ImprovementOpportunity } from "../shared/execution-evidence.ts";
import type { Store } from "./store.ts";
import type { ProjectionControl, ProjectionIdentity } from "./projection-ledger.ts";
import type { StoreReadLocation } from "./store-read.ts";
import type { ProjectionCheckpoint, HistoryProjectionBatch } from "./history-projection.ts";
import { improvementOpportunitySchema, projectionCheckpointSchema, type HistoryQueryOptions } from "./history-protocol.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { PROJECTION_MESSAGE_BYTES, PROJECTION_QUEUE_LIMIT, projectionCommandSchema,
  projectionWorkerOutputSchema, projectionWireError, type ProjectionCommand, type ProjectionMetadata,
} from "./projection-writer-protocol.ts";

const workerPath = fileURLToPath(new URL("./projection-writer-worker.ts", import.meta.url));
const decoder = new TextDecoder("utf-8", { fatal: true });
export class ProjectionWriterError extends Error {
  constructor(readonly code: string, message: string, readonly persistence: "not_started" | "unknown") {
    super(message); this.name = "ProjectionWriterError";
  }
}
interface PendingMutation {
  id: number; command: ProjectionCommand; deadlineOs: string; signal?: AbortSignal;
  abort(): void; timer?: ReturnType<typeof setTimeout>; failure: Error | null;
  resolve(value: unknown): void; reject(error: Error): void;
}
interface OwnedProjectionChild {
  process: ChildProcess;
  drained: Promise<void>; finishDrain(): void; stopping: boolean; rejectQueued: boolean;
  serial: number; output: Buffer;
}

/** One independent derived process. This facade opens no writable database. */
export class ProjectionWriterClient {
  private readiness: Promise<void> | null = null;
  private readonly control: ProjectionControl;
  private readonly location: StoreReadLocation;
  private readonly identity: ProjectionIdentity;
  private readonly queue: PendingMutation[] = [];
  private child: OwnedProjectionChild | null = null;
  private current: PendingMutation | null = null;
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(store: Store) {
    const handoff = store.handoffProjectionWriter();
    this.control = handoff.control; this.location = handoff.location; this.identity = handoff.identity;
  }
  /** Start only after the enclosing owner has returned and can be closed. */
  get ready(): Promise<void> {
    if (!this.readiness) {
      this.readiness = this.request({ kind: "drain" }, { deadlineHostMs: performance.now() + 5000 })
        .then(value => { z.null().parse(value); });
      // Initialization owns and later awaits this same failure.
      void this.readiness.catch(() => {});
    }
    return this.readiness;
  }
  snapshot(): { closed: boolean; worker_closed: boolean; active: boolean; queued: number } {
    return { closed: this.closed, worker_closed: this.child === null, active: this.current !== null, queued: this.queue.length };
  }
  async beginHistoryProjection(runId: string, desiredThrough: number | undefined, options: HistoryQueryOptions): Promise<ProjectionCheckpoint> {
    void this.ready;
    return projectionCheckpointSchema.parse(await this.request({ kind: "begin", run_id: runId,
      ...(desiredThrough === undefined ? {} : { desired_through: desiredThrough }) }, options));
  }
  async commitHistoryProjectionBatch(runId: string, batch: HistoryProjectionBatch, options: HistoryQueryOptions): Promise<void> {
    void this.ready;
    z.null().parse(await this.request({ kind: "commit", run_id: runId, batch }, options));
  }
  async resolveOpportunity(runId: string, id: string, resolution: NonNullable<ImprovementOpportunity["resolution"]>, options: HistoryQueryOptions): Promise<ImprovementOpportunity> {
    void this.ready;
    return improvementOpportunitySchema.parse(await this.request({ kind: "resolve", run_id: runId, opportunity_id: id, resolution }, options));
  }
  cancelRun(runId: string): Promise<void> {
    for (const pending of [...this.queue]) if ("run_id" in pending.command && pending.command.run_id === runId)
      this.cancel(pending, new ProjectionWriterError("history_cancelled", "Derived history request was cancelled before dispatch", "not_started"));
    const current = this.current, child = this.child;
    if (!current || !child || !("run_id" in current.command) || current.command.run_id !== runId) return Promise.resolve();
    this.cancel(current, new ProjectionWriterError("history_cancelled", "Derived history request was cancelled; persistence may already have completed", "unknown"));
    return child.drained;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.rejectQueued(new ProjectionWriterError("history_closed", "Derived history writer is closed", "not_started"));
    const child = this.child;
    if (child) this.stop(child, new ProjectionWriterError("history_closed", "Derived history writer closed; persistence may already have completed", "unknown"), true);
    this.closing = child?.drained ?? Promise.resolve();
    return this.closing;
  }
  private request(command: ProjectionCommand, options: HistoryQueryOptions): Promise<unknown> {
    try {
      if (this.closed) throw new ProjectionWriterError("history_closed", "Derived history writer is closed", "not_started");
      const startedOs = osMonotonicNs(), started = performance.now();
      if (!Number.isFinite(options.deadlineHostMs) || options.deadlineHostMs <= started || options.signal?.aborted)
        throw new ProjectionWriterError("history_deadline", "Derived history request expired before admission", "not_started");
      if (this.queue.length >= PROJECTION_QUEUE_LIMIT) throw new ProjectionWriterError("history_queue_full", "Derived history mutation queue is full", "not_started");
      if (!Number.isSafeInteger(this.nextId)) throw new Error("Projection mutation identities exhausted");
      const id = this.nextId++;
      const deadlineOs = (startedOs + BigInt(Math.floor((options.deadlineHostMs - started) * 1e6))).toString();
      const parsed = projectionCommandSchema.parse(command);
      const envelope = { v: 1, type: "job", id, deadline_os_ns: deadlineOs, command: parsed };
      if (Buffer.byteLength(JSON.stringify(envelope) + "\n") > PROJECTION_MESSAGE_BYTES)
        throw new ProjectionWriterError("history_message_limit", "Derived history request exceeds its envelope", "not_started");
      const completion = Promise.withResolvers<unknown>();
      const pending: PendingMutation = { id, command: parsed, deadlineOs, signal: options.signal, failure: null,
        abort: () => this.cancel(pending, new ProjectionWriterError("history_cancelled", "Derived history request was cancelled", this.current === pending ? "unknown" : "not_started")),
        resolve: completion.resolve, reject: completion.reject };
      this.queue.push(pending);
      pending.signal?.addEventListener("abort", pending.abort, { once: true });
      pending.timer = setTimeout(() => this.cancel(pending, new ProjectionWriterError("history_deadline", "Derived history request reached its original deadline", this.current === pending ? "unknown" : "not_started")), Math.max(1, options.deadlineHostMs - performance.now()));
      if (pending.signal?.aborted) pending.abort();
      this.pump();
      return completion.promise;
    } catch (error) { return Promise.reject(error); }
  }
  private pump(): void {
    if (this.closed || this.current || this.child?.stopping) return;
    const pending = this.queue.shift();
    if (!pending) return;
    if (pending.signal?.aborted || osMonotonicNs() >= BigInt(pending.deadlineOs)) {
      this.cleanup(pending); pending.reject(new ProjectionWriterError("history_deadline", "Derived history request expired in its original queue", "not_started"));
      queueMicrotask(() => this.pump()); return;
    }
    this.current = pending;
    try {
      const child = this.child ?? this.start();
      child.process.stdin!.write(JSON.stringify({ v: 1, type: "job", id: pending.id,
        deadline_os_ns: pending.deadlineOs, command: pending.command }) + "\n", error => {
        if (error) this.stop(child, new ProjectionWriterError("history_worker_io", "Derived history input pipe failed", "unknown"), true);
      });
    } catch {
      const error = new ProjectionWriterError("history_worker_start", "Derived history worker could not start", "unknown");
      if (this.child) this.stop(this.child, error, true);
      else { this.current = null; this.cleanup(pending); pending.reject(error); this.rejectQueued(error); }
    }
  }
  private start(): OwnedProjectionChild {
    const processChild = spawn(process.execPath, ["--no-env-file", workerPath, this.location.database,
      this.location.artifacts, this.location.projection!, this.identity.source_id, this.identity.projection_id], {
      cwd: path.dirname(workerPath), env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const completion = Promise.withResolvers<void>();
    const child: OwnedProjectionChild = { process: processChild,
      drained: completion.promise, finishDrain: completion.resolve, stopping: false, rejectQueued: false,
      serial: 0, output: Buffer.alloc(0) };
    this.child = child;
    const failed = () => this.stop(child, new ProjectionWriterError("history_worker_failed", "Derived history worker failed; inspect retained state before correction", "unknown"), true);
    processChild.stdout!.on("data", (chunk: Buffer) => this.read(child, chunk));
    processChild.on("error", failed); processChild.stdin!.on("error", failed);
    processChild.stdout!.on("error", failed);
    const eof = () => { if (!child.stopping) failed(); };
    processChild.stdout!.once("end", eof); processChild.stdout!.once("close", eof);
    processChild.once("spawn", () => {
      if (child.stopping) processChild.kill("SIGKILL");
    });
    processChild.once("exit", () => { if (!child.stopping) failed(); });
    processChild.once("close", () => {
      if (this.child === child) {
        this.child = null;
        const pending = this.current; this.current = null;
        if (pending) { this.cleanup(pending); pending.reject(pending.failure ?? new ProjectionWriterError("history_worker_closed", "Derived history writer closed without confirming its request", "unknown")); }
        if (child.rejectQueued) this.rejectQueued(new ProjectionWriterError("history_worker_closed", "Derived history writer failed before queued work was dispatched", "not_started"));
      }
      child.finishDrain(); this.pump();
    });
    return child;
  }
  private cleanup(pending: PendingMutation): void {
    clearTimeout(pending.timer); pending.signal?.removeEventListener("abort", pending.abort);
  }
  private cancel(pending: PendingMutation, error: Error): void {
    if (this.current === pending && this.child) { this.stop(this.child, error, false); return; }
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1); this.cleanup(pending); pending.reject(error);
  }
  private rejectQueued(error: Error): void {
    for (const pending of this.queue.splice(0)) { this.cleanup(pending); pending.reject(error); }
  }
  private stop(child: OwnedProjectionChild, error: Error, rejectQueued: boolean): void {
    if (this.child !== child) return;
    if (this.current) this.current.failure ??= error;
    child.rejectQueued ||= rejectQueued;
    if (child.stopping) return;
    child.stopping = true;
    child.process.stdin!.destroy();
    child.process.kill("SIGKILL");
    child.process.stdout!.resume();
  }
  private metadata(command: ProjectionMetadata): unknown {
    if (command.kind === "publication") return this.control.publication(command.hash);
    if (command.kind === "accept") { this.control.acceptPublication(command.run_id, command.hash, command.source_through); return null; }
    if (command.kind === "audit") return this.control.appendAudit(command.receipt_id, command.run_id, command.payload);
    this.control.publishAudit(command.event_seq); return null;
  }
  private read(child: OwnedProjectionChild, chunk: Buffer): void {
    if (this.child !== child || child.stopping) return;
    try {
      if (child.output.byteLength + chunk.byteLength > PROJECTION_MESSAGE_BYTES) throw new Error("Projection reply exceeds its envelope");
      child.output = child.output.byteLength ? Buffer.concat([child.output, chunk]) : chunk;
      for (;;) {
        const newline = child.output.indexOf(10);
        if (newline < 0) break;
        const line = child.output.subarray(0, newline); child.output = child.output.subarray(newline + 1);
        this.message(child, JSON.parse(decoder.decode(line)));
        if (child.stopping) break;
      }
    } catch { this.stop(child, new ProjectionWriterError("history_protocol", "Derived history worker protocol failed; inspect retained state before correction", "unknown"), true); }
  }
  private message(child: OwnedProjectionChild, value: unknown): void {
    const message = projectionWorkerOutputSchema.parse(value);
    const current = this.current;
    if (!current) throw new Error("Projection worker has no admitted channel owner");
    if (message.type === "metadata") {
      if (message.job_id !== current.id || message.deadline_os_ns !== current.deadlineOs || message.serial !== child.serial + 1)
        throw new Error("Projection metadata has foreign ownership");
      child.serial = message.serial;
      let reply;
      try {
        if (this.closed || current.failure || child.stopping) throw new RuntimeFault("history_cancelled", "Derived history request was cancelled");
        if (osMonotonicNs() >= BigInt(current.deadlineOs)) throw new RuntimeFault("history_deadline", "Derived history request deadline expired");
        reply = { ok: true, value: this.metadata(message.command) };
      } catch (error) { reply = { ok: false, error: projectionWireError(error) }; }
      const encoded = JSON.stringify({ serial: message.serial, reply }) + "\n";
      if (Buffer.byteLength(encoded) > PROJECTION_MESSAGE_BYTES) throw new Error("Projection metadata reply exceeds its envelope");
      child.process.stdin!.write(encoded, error => { if (error) this.stop(child, new ProjectionWriterError("history_worker_io", "Derived metadata reply pipe failed", "unknown"), true); });
      return;
    }
    if (message.id !== current.id) throw new Error("Projection result has foreign ownership");
    this.current = null; this.cleanup(current);
    if (current.failure) current.reject(current.failure);
    else if (!message.reply.ok) current.reject(new ProjectionWriterError(message.reply.error.code, message.reply.error.message, "unknown"));
    else current.resolve(message.reply.value);
    this.pump();
  }
}
