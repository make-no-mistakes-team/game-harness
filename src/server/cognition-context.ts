import path from "node:path";
import type { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { ReadonlyStore, type StoreReadLocation } from "./store-read.ts";
import { StrategicContext } from "./strategic-context.ts";
import { parseContextCheckpoint, parsePassiveContextState, type PassiveContextState } from "./cognition-context-custody.ts";
import type { ContextAssemblyOptions } from "./strategic-context-client.ts";
import { CONTEXT_PROTOCOL_VERSION, CONTEXT_WORKER_LIMITS, contextOperationSchema, contextRequestSchema,
  type ContextAssemblyInput, type ContextOperation } from "./strategic-context-protocol.ts";

/** Retained passive knowledge, not a provider transcript or physical-host authority. */
export interface ContextOwner {
  open(): void;
  reset(): void;
  rememberHelp(topic: string, value: Json): void;
  selectProgram(name: string, version: number): void;
  assemble(input: ContextAssemblyInput, options: ContextAssemblyOptions): Promise<string>;
  close(): Promise<void>;
}

const failure = () => new RuntimeFault("backend_unavailable", "Strategic retained context could not complete");
type ContextRequest = z.infer<typeof contextRequestSchema>;
interface PendingContext {
  request: ContextRequest;
  deadline: bigint;
  signal?: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (context: string) => void;
  reject: (error: Error) => void;
}
export interface ContextCustodyCommit {
  (state: PassiveContextState, deadlineOsNs: bigint, signal?: AbortSignal): Promise<void>;
}

/** Shared reducer inside the owned cognition process; never starts a grandchild.
 * The host must still watchdog and join that process when its event loop stalls.
 * Only a fully bounded, still-current result commits checkpoint/operation custody.
 */
export class InlineCognitionContext implements ContextOwner {
  readonly #location: StoreReadLocation;
  readonly #now: () => bigint;
  #store: ReadonlyStore | null = null;
  #active: PendingContext | null = null;
  #queue: PendingContext[] = [];
  #operations: ContextOperation[] = [];
  #operationBytes = 0;
  #checkpoint: string | null = null;
  #nextId = 1;
  #closed = false;
  #failed = false;
  #working = false;
  #closing: { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } | null = null;

  // The optional clock is a deterministic test seam. Production uses Linux
  // CLOCK_MONOTONIC, including before and after synchronous reducer work.
  constructor(location: StoreReadLocation, now: () => bigint = osMonotonicNs,
    private readonly commitCustody?: ContextCustodyCommit) {
    if (!location || !location.database || !location.artifacts || !location.projection ||
        [location.database, location.artifacts, location.projection].some(value => typeof value !== "string" || value.includes("\0")))
      throw failure();
    this.#location = Object.freeze({ database: path.resolve(location.database), artifacts: path.resolve(location.artifacts),
      projection: path.resolve(location.projection) });
    this.#now = now;
  }

  open(): void {
    if (this.#store || this.#active || this.#queue.length || this.#closing) throw failure();
    this.#closed = false; this.#failed = false;
  }

  reset(): void {
    if (this.#store || this.#active || this.#queue.length || this.#closing) throw failure();
    this.#checkpoint = null; this.#operations = []; this.#operationBytes = 0; this.#failed = false;
  }

  /** Capture committed reducer state plus every ordered, unacknowledged operation. */
  capture(): PassiveContextState {
    return parsePassiveContextState({ v: 1, checkpoint: this.#checkpoint,
      operations: [...(this.#active?.request.operations ?? []),
        ...this.#queue.flatMap(pending => pending.request.operations), ...this.#operations] });
  }

  /** Import passive custody only; the next real assembly must synchronize scope. */
  restore(value: unknown): void {
    if (this.#store || this.#active || this.#queue.length || this.#closing) throw failure();
    const state = parsePassiveContextState(value);
    this.#checkpoint = state.checkpoint; this.#operations = state.operations;
    this.#operationBytes = state.operations.reduce((sum, operation) => sum + Buffer.byteLength(JSON.stringify(operation)), 0);
  }

  rememberHelp(topic: string, value: Json): void { this.#remember({ kind: "help", topic, value }); }
  selectProgram(name: string, version: number): void { this.#remember({ kind: "select", name, version }); }

  #remember(operation: ContextOperation): void {
    try {
      const encoded = JSON.stringify(operation), size = Buffer.byteLength(encoded);
      const count = this.#operations.length + (this.#active?.request.operations.length ?? 0) +
        this.#queue.reduce((sum, pending) => sum + pending.request.operations.length, 0);
      if (this.#closed || this.#failed || count >= CONTEXT_WORKER_LIMITS.operations ||
          this.#operationBytes + size > CONTEXT_WORKER_LIMITS.requestBytes / 2) throw failure();
      this.#operations.push(contextOperationSchema.parse(JSON.parse(encoded)));
      this.#operationBytes += size;
    } catch { this.#cancel(); throw failure(); }
  }

  assemble(input: ContextAssemblyInput, options: ContextAssemblyOptions): Promise<string> {
    try {
      const now = this.#now();
      if (this.#closed || this.#failed || options.signal?.aborted || typeof options.deadlineOsNs !== "bigint" ||
          options.deadlineOsNs <= now || this.#queue.length >= CONTEXT_WORKER_LIMITS.queued || !Number.isSafeInteger(this.#nextId)) throw failure();
      const ceiling = now + BigInt(CONTEXT_WORKER_LIMITS.jobMs) * 1_000_000n;
      const deadline = options.deadlineOsNs < ceiling ? options.deadlineOsNs : ceiling;
      const encoded = JSON.stringify({ v: CONTEXT_PROTOCOL_VERSION, id: this.#nextId,
        deadline_os_ns: deadline.toString(), checkpoint: null, ...input, operations: this.#operations });
      if (Buffer.byteLength(encoded) > CONTEXT_WORKER_LIMITS.requestBytes) throw failure();
      // Detach scope, adapter descriptors and tool-result JSON before queueing.
      const request = contextRequestSchema.parse(JSON.parse(encoded));
      const completion = Promise.withResolvers<string>();
      const pending: PendingContext = { request, deadline, signal: options.signal, abort: () => this.#cancel(),
        resolve: completion.resolve, reject: completion.reject };
      this.#nextId++; this.#operations = [];
      this.#queue.push(pending);
      pending.signal?.addEventListener("abort", pending.abort, { once: true });
      pending.timer = setTimeout(() => this.#cancel(), Math.max(1, Number((deadline - now) / 1_000_000n)));
      if (pending.signal?.aborted) pending.abort();
      this.#pump();
      return completion.promise;
    } catch { return Promise.reject(failure()); }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing.promise;
    this.#closed = true;
    const closing = Promise.withResolvers<void>();
    this.#closing = closing;
    // Synchronous reducer work cannot be preempted. Reentrant close/abort must
    // not close a pinned database or report a drain before that work unwinds.
    if (!this.#working) this.#drainFailure();
    return closing.promise;
  }

  #cleanup(pending: PendingContext): void {
    clearTimeout(pending.timer); pending.signal?.removeEventListener("abort", pending.abort);
  }

  #cancel(): void {
    this.#failed = true;
    if (!this.#working) this.#drainFailure();
  }

  #drainFailure(): void {
    const pending = [...(this.#active ? [this.#active] : []), ...this.#queue];
    this.#active = null; this.#queue = [];
    // Failed assemblies acknowledge neither new scope nor queued knowledge.
    this.#operations = [...pending.flatMap(value => value.request.operations), ...this.#operations];
    this.#operationBytes = this.#operations.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
    const closing = this.#closing;
    try {
      this.#store?.close(); this.#store = null;
      closing?.resolve();
    } catch { closing?.reject(failure()); }
    finally {
      if (this.#closing === closing) this.#closing = null;
      for (const request of pending) { this.#cleanup(request); request.reject(failure()); }
    }
  }

  #pump(): void {
    if (this.#closed || this.#failed || this.#active || !this.#queue.length) return;
    const pending = this.#queue.shift()!;
    this.#active = pending;
    queueMicrotask(() => { void this.#compute(pending); });
  }

  #assertCurrent(pending: PendingContext): void {
    const now = this.#now();
    if (this.#closed || this.#failed || pending.signal?.aborted || now >= pending.deadline) throw failure();
  }

  async #compute(pending: PendingContext): Promise<void> {
    if (this.#active !== pending) return;
    this.#working = true;
    try {
      this.#assertCurrent(pending);
      const request = pending.request;
      const encoded = JSON.stringify({ ...request, checkpoint: this.#checkpoint }) + "\n";
      if (Buffer.byteLength(encoded) > CONTEXT_WORKER_LIMITS.requestBytes) throw failure();
      const store = this.#store ??= new ReadonlyStore(this.#location);
      const retained = new StrategicContext(store);
      if (this.#checkpoint !== null) retained.restore(parseContextCheckpoint(this.#checkpoint));
      this.#assertCurrent(pending);
      // No await, serialization or idle retention while source/projection are pinned.
      const context = store.snapshot(() => {
        const run = store.getRun(request.scope.run_id);
        if (!run) throw failure();
        Object.assign(run, request.scope);
        for (const operation of request.operations) {
          if (operation.kind === "help") retained.rememberHelp(operation.topic, operation.value);
          else retained.selectProgram(operation.name, operation.version);
        }
        retained.synchronize(run, request.model, { messages: [] }, request.observation, request.adapter);
        return retained.assemble(run, request.adapter, request.pendingAuthoring);
      });
      const checkpoint = JSON.stringify(retained.checkpoint());
      const response = JSON.stringify({ v: CONTEXT_PROTOCOL_VERSION, id: request.id, ok: true,
        context, checkpoint, worker_pid: process.pid }) + "\n";
      if (Buffer.byteLength(context) > CONTEXT_WORKER_LIMITS.contextBytes ||
          Buffer.byteLength(checkpoint) > CONTEXT_WORKER_LIMITS.checkpointBytes ||
          Buffer.byteLength(response) > CONTEXT_WORKER_LIMITS.responseBytes) throw failure();
      parseContextCheckpoint(checkpoint);
      this.#assertCurrent(pending);
      if (this.commitCustody) {
        const state = parsePassiveContextState({ v: 1, checkpoint,
          operations: [...this.#queue.flatMap(value => value.request.operations), ...this.#operations] });
        this.#assertCurrent(pending);
        await this.commitCustody(state, pending.deadline, pending.signal);
        this.#assertCurrent(pending);
      }
      this.#checkpoint = checkpoint;
      this.#operationBytes -= request.operations.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
      this.#active = null; this.#cleanup(pending); pending.resolve(context);
    } catch { this.#failed = true; }
    finally {
      this.#working = false;
      if (this.#closed || this.#failed) this.#drainFailure();
      else this.#pump();
    }
  }
}
