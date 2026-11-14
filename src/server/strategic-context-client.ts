import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Json } from "../shared/contracts.ts";
import type { StoreReadLocation } from "./store-read.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { CONTEXT_PROTOCOL_VERSION, CONTEXT_WORKER_LIMITS, contextOperationSchema, contextRequestSchema,
  contextResponseSchema, type ContextAssemblyInput, type ContextOperation } from "./strategic-context-protocol.ts";

const workerPath = fileURLToPath(new URL("./strategic-context-worker.ts", import.meta.url));
const failure = () => new RuntimeFault("backend_unavailable", "Strategic retained context worker could not complete; no local reconstruction was used");
interface PendingContext {
  id: number; input: ContextAssemblyInput; operations: ContextOperation[]; deadline: bigint; signal?: AbortSignal;
  abort: () => void; timer?: ReturnType<typeof setTimeout>;
  resolve: (context: string) => void; reject: (error: Error) => void;
}
interface OwnedContextChild {
  process: ChildProcess; drained: Promise<void>; finishDrain: () => void;
  stopping: boolean; bytes: number; parts: Buffer[];
}
export interface ContextAssemblyOptions { deadlineOsNs: bigint; signal?: AbortSignal }

/** Ordered retained-knowledge custody. Only bounded declarative state crosses the pipe. */
export class StrategicContextClient {
  readonly #location: StoreReadLocation;
  #child: OwnedContextChild | null = null;
  #active: PendingContext | null = null;
  #queue: PendingContext[] = [];
  #operations: ContextOperation[] = [];
  #operationBytes = 0;
  #checkpoint: string | null = null;
  #nextId = 1;
  #closed = false;
  #closing: Promise<void> | null = null;
  #failed = false;
  #workerPid: number | null = null;

  constructor(location: StoreReadLocation) {
    if (!location || !location.database || !location.artifacts || !location.projection ||
        [location.database, location.artifacts, location.projection].some(value => typeof value !== "string" || value.includes("\0")))
      throw failure();
    this.#location = Object.freeze({ database: path.resolve(location.database), artifacts: path.resolve(location.artifacts),
      projection: path.resolve(location.projection) });
  }

  snapshot() { return { closed: this.#closed, active: this.#active !== null, queued: this.#queue.length,
    worker_pid: this.#workerPid, child_pid: this.#child?.process.pid ?? null }; }

  open(): void {
    if (this.#child || this.#active || this.#queue.length || this.#closing) throw failure();
    this.#closed = false; this.#failed = false;
  }

  reset(): void {
    if (this.#child || this.#active || this.#queue.length || this.#closing) throw failure();
    this.#checkpoint = null; this.#operations = []; this.#operationBytes = 0; this.#failed = false;
  }

  rememberHelp(topic: string, value: Json): void { this.#remember({ kind: "help", topic, value }); }
  selectProgram(name: string, version: number): void { this.#remember({ kind: "select", name, version }); }

  #remember(operation: ContextOperation): void {
    try {
      // Detach only trusted JSON, never adapter functions or mutable tool results.
      const encoded = JSON.stringify(operation), size = Buffer.byteLength(encoded);
      const retainedOperations = this.#operations.length + (this.#active?.operations.length ?? 0) +
        this.#queue.reduce((sum, pending) => sum + pending.operations.length, 0);
      if (this.#closed || this.#failed || retainedOperations >= CONTEXT_WORKER_LIMITS.operations ||
          this.#operationBytes + size > CONTEXT_WORKER_LIMITS.requestBytes / 2) throw failure();
      this.#operations.push(contextOperationSchema.parse(JSON.parse(encoded)));
      this.#operationBytes += size;
    } catch { this.#failed = true; throw failure(); }
  }

  assemble(input: ContextAssemblyInput, options: ContextAssemblyOptions): Promise<string> {
    try {
      const now = osMonotonicNs();
      if (this.#closed || this.#failed || options.signal?.aborted || typeof options.deadlineOsNs !== "bigint" ||
          options.deadlineOsNs <= now || this.#queue.length >= CONTEXT_WORKER_LIMITS.queued || !Number.isSafeInteger(this.#nextId)) throw failure();
      const deadline = options.deadlineOsNs < now + BigInt(CONTEXT_WORKER_LIMITS.jobMs) * 1_000_000n
        ? options.deadlineOsNs : now + BigInt(CONTEXT_WORKER_LIMITS.jobMs) * 1_000_000n;
      const operations = this.#operations;
      const request = contextRequestSchema.parse({ v: CONTEXT_PROTOCOL_VERSION, id: this.#nextId,
        deadline_os_ns: deadline.toString(), checkpoint: null, ...input, operations });
      const detached = JSON.stringify(request);
      if (Buffer.byteLength(detached) > CONTEXT_WORKER_LIMITS.requestBytes) throw failure();
      // Parsing here detaches the admitted scope before an asynchronous queue wait.
      const immutable = JSON.parse(detached) as ContextAssemblyInput;
      const completion = Promise.withResolvers<string>();
      const pending: PendingContext = { id: this.#nextId++, input: immutable, operations,
        deadline, signal: options.signal, abort: () => this.#cancel(), resolve: completion.resolve, reject: completion.reject };
      this.#operations = [];
      this.#queue.push(pending);
      pending.signal?.addEventListener("abort", pending.abort, { once: true });
      pending.timer = setTimeout(() => this.#cancel(), Math.max(1, Number((deadline - now) / 1_000_000n)));
      if (pending.signal?.aborted) pending.abort();
      this.#pump();
      return completion.promise;
    } catch { return Promise.reject(failure()); }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const child = this.#child;
    if (!child) {
      this.#rejectAll();
      return Promise.resolve();
    }
    this.#stop(child);
    const closing = child.drained;
    this.#closing = closing;
    void closing.finally(() => { if (this.#closing === closing) this.#closing = null; }).catch(() => {});
    return closing;
  }

  #cleanup(pending: PendingContext): void {
    clearTimeout(pending.timer); pending.signal?.removeEventListener("abort", pending.abort);
  }

  #rejectAll(): void {
    const pending = [...(this.#active ? [this.#active] : []), ...this.#queue];
    this.#active = null; this.#queue = [];
    // A failed or cancelled request never acknowledges its retained mutations.
    // Preserve their order for an explicit reopen; no automatic local retry.
    this.#operations = [...pending.flatMap(value => value.operations), ...this.#operations];
    this.#operationBytes = this.#operations.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
    for (const request of pending) { this.#cleanup(request); request.reject(failure()); }
  }

  #cancel(): void {
    this.#failed = true;
    if (this.#child) this.#stop(this.#child);
    else this.#rejectAll();
  }

  #pump(): void {
    if (this.#closed || this.#failed || this.#active || this.#child?.stopping || !this.#queue.length) return;
    this.#active = this.#queue.shift()!;
    try {
      const pending = this.#active;
      if (pending.signal?.aborted || osMonotonicNs() >= pending.deadline) { this.#cancel(); return; }
      const line = JSON.stringify({ ...pending.input, v: CONTEXT_PROTOCOL_VERSION, id: pending.id,
        deadline_os_ns: pending.deadline.toString(), checkpoint: this.#checkpoint, operations: pending.operations }) + "\n";
      if (Buffer.byteLength(line) > CONTEXT_WORKER_LIMITS.requestBytes) { this.#cancel(); return; }
      const child = this.#child ?? this.#start();
      child.process.stdin!.write(line, error => { if (error) this.#cancel(); });
    } catch { this.#cancel(); }
  }

  #start(): OwnedContextChild {
    const processChild = spawn(process.execPath, ["--no-env-file", workerPath, this.#location.database,
      this.#location.artifacts, this.#location.projection!], { cwd: path.dirname(workerPath),
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }, stdio: ["pipe", "pipe", "ignore"] });
    const drain = Promise.withResolvers<void>();
    const child: OwnedContextChild = { process: processChild, drained: drain.promise, finishDrain: drain.resolve,
      stopping: false, bytes: 0, parts: [] };
    this.#child = child;
    processChild.stdout!.on("data", (chunk: Buffer) => this.#read(child, chunk));
    processChild.stdout!.on("error", () => this.#cancel());
    processChild.stdin!.on("error", () => this.#cancel());
    processChild.on("error", () => this.#cancel());
    processChild.once("exit", () => { if (!child.stopping) this.#cancel(); });
    processChild.stdout!.once("end", () => { if (!child.stopping) this.#cancel(); });
    // Child close joins process exit and all owned stdio, even after a late spawn.
    processChild.once("close", () => {
      child.stopping = true;
      queueMicrotask(() => {
        child.parts = []; child.bytes = 0;
        if (this.#child === child) { this.#child = null; this.#rejectAll(); }
        child.finishDrain();
      });
    });
    return child;
  }

  #stop(child: OwnedContextChild): void {
    if (child.stopping) return;
    child.stopping = true; child.parts = []; child.bytes = 0;
    // A synchronous reducer cannot service cancellation IPC. Settlement still joins close.
    try { child.process.kill("SIGKILL"); } catch { /* close owns the join. */ }
  }

  #read(child: OwnedContextChild, chunk: Buffer): void {
    if (child.stopping) return;
    try {
      let offset = 0;
      let completed: { context: string; checkpoint: string; workerPid: number } | null = null;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset), through = end < 0 ? chunk.length : end + 1;
        const length = through - offset;
        if (child.bytes + length > CONTEXT_WORKER_LIMITS.responseBytes) throw failure();
        child.parts.push(Buffer.from(chunk.subarray(offset, through))); child.bytes += length; offset = through;
        if (end < 0) break;
        if (completed) throw failure();
        const bytes = Buffer.concat(child.parts, child.bytes); child.parts = []; child.bytes = 0;
        const frame = contextResponseSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 1))));
        if (!this.#active || frame.id !== this.#active.id || !frame.ok || frame.worker_pid === process.pid ||
            frame.worker_pid !== child.process.pid || Buffer.byteLength(frame.context) > CONTEXT_WORKER_LIMITS.contextBytes ||
            Buffer.byteLength(frame.checkpoint) > CONTEXT_WORKER_LIMITS.checkpointBytes) throw failure();
        completed = { context: frame.context, checkpoint: frame.checkpoint, workerPid: frame.worker_pid };
      }
      if (!completed) return;
      if (child.bytes) throw failure();
      const pending = this.#active!;
      if (this.#closed || this.#failed || pending.signal?.aborted || osMonotonicNs() >= pending.deadline) throw failure();
      this.#checkpoint = completed.checkpoint; this.#workerPid = completed.workerPid;
      this.#operationBytes -= pending.operations.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
      this.#active = null; this.#cleanup(pending); pending.resolve(completed.context);
      queueMicrotask(() => this.#pump());
    } catch { this.#cancel(); }
  }
}
