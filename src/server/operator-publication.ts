import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { StoreReadLocation } from "./store-read.ts";
import { PUBLICATION_LIMITS, PublicationUnavailable, isPublicationRoute, type PublicationSeed } from "./operator-publication-protocol.ts";

interface ActiveRequest { abort: AbortController; done: Promise<void>; finish(): void }
export interface PublicationOwnerOptions {
  /** A real alternate worker executable is useful for infrastructure failure tests. */
  workerPath?: string;
}

/** Owns one readonly process. Source-heavy responses are opaque, backpressured bytes. */
export class OperatorPublication {
  readonly #token = randomBytes(32).toString("hex");
  readonly #instance = randomBytes(32).toString("hex");
  readonly #child: ChildProcess;
  readonly #ready = Promise.withResolvers<string>();
  readonly #drained = Promise.withResolvers<void>();
  readonly #active = new Set<ActiveRequest>();
  #origin: string | null = null;
  #failure: PublicationUnavailable | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;
  #dirty = false;
  #scheduled: NodeJS.Immediate | null = null;
  #publishing: Promise<void> | null = null;
  #sequence = 0;
  #published = 0;
  #coalesced = 0;
  #seedAbort: AbortController | null = null;
  #startupTimer: NodeJS.Timeout;

  constructor(location: StoreReadLocation, experience: string,
    private readonly readSeed: () => Omit<PublicationSeed, "sequence">,
    options: PublicationOwnerOptions = {}) {
    const workerPath = options.workerPath ?? fileURLToPath(new URL("./operator-publication-worker.ts", import.meta.url));
    const child = this.#child = spawn(process.execPath, ["--no-env-file", workerPath], {
      cwd: path.dirname(workerPath),
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let readyLine = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (this.#closed || this.#failure) return;
      if (this.#origin || readyLine.length + chunk.length > 256) {
        this.#fail(); return;
      }
      readyLine += chunk.toString("utf8");
      if (!readyLine.endsWith("\n")) return;
      try {
        const value: unknown = JSON.parse(readyLine);
        if (!value || typeof value !== "object" || !("port" in value) || !Number.isInteger(value.port) ||
          typeof value.port !== "number" || value.port < 1 || value.port > 65535 || Object.keys(value).length !== 1)
          throw new Error("Invalid readiness");
        this.#origin = `http://127.0.0.1:${value.port}`;
        clearTimeout(this.#startupTimer);
        this.#ready.resolve(this.#origin);
      } catch { this.#fail(); }
    });
    child.on("error", () => this.#fail());
    child.once("spawn", () => {
      if (this.#closed || this.#failure) {
        try { child.kill("SIGKILL"); } catch { /* Actual close still owns the drain. */ }
      }
    });
    child.once("exit", () => { if (!this.#closed) this.#fail(); });
    child.stdin!.on("error", () => { if (!this.#closed) this.#fail(); });
    child.stdout!.on("error", () => { if (!this.#closed) this.#fail(); });
    child.stdout!.once("end", () => { if (!this.#closed) this.#fail(); });
    child.once("close", () => {
      if (!this.#closed) this.#fail();
      // close follows exit AND actual closure of both owned ordinary pipes.
      this.#drained.resolve();
    });
    this.#startupTimer = setTimeout(() => this.#fail(), PUBLICATION_LIMITS.startupMs);
    void this.#ready.promise.catch(() => {});
    child.stdin!.write(JSON.stringify({ token: this.#token, instance: this.#instance, location, experience }) + "\n",
      error => { if (error) this.#fail(); });
    this.notify();
  }

  snapshot() {
    return { pid: this.#child.pid ?? null, ready: this.#origin !== null, failed: this.#failure !== null,
      closed: this.#closed, seed_in_flight: this.#publishing !== null, latest_pending: this.#dirty,
      published_seeds: this.#published, coalesced_changes: this.#coalesced, active_requests: this.#active.size };
  }

  /** Constant-space notification: never hydrate Store data in an onChange listener. */
  notify(): void {
    if (this.#closed || this.#failure) return;
    if (this.#dirty) this.#coalesced++;
    this.#dirty = true;
    if (this.#publishing || this.#scheduled) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      this.#publish();
    });
  }

  #publish(): void {
    if (!this.#dirty || this.#closed || this.#failure || this.#publishing) return;
    this.#dirty = false;
    const work = (async () => {
      const origin = await this.#ready.promise;
      if (this.#closed || this.#failure) throw new PublicationUnavailable();
      const line = JSON.stringify({ ...this.readSeed(), sequence: ++this.#sequence });
      if (Buffer.byteLength(line) > PUBLICATION_LIMITS.seedBytes) throw new PublicationUnavailable(503, "Live operator state exceeds its publication budget");
      const abort = this.#seedAbort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PUBLICATION_LIMITS.requestMs);
      try {
        const response = await fetch(origin + "/private/seed", {
          method: "POST", headers: this.#headers(), body: line, signal: abort.signal,
        });
        await response.body?.cancel();
        if (response.status !== 204) throw new PublicationUnavailable();
        this.#published++;
      } finally { clearTimeout(timer); this.#seedAbort = null; }
    })();
    this.#publishing = work.then(() => {
      this.#publishing = null;
      if (this.#dirty && !this.#closed && !this.#failure) this.notify();
    }, () => {
      this.#publishing = null;
      this.#fail();
    });
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, "x-publication-instance": this.#instance };
  }

  async #flush(): Promise<void> {
    if (this.#closed || this.#failure) throw this.#failure ?? new PublicationUnavailable();
    if (this.#scheduled) { clearImmediate(this.#scheduled); this.#scheduled = null; }
    // Join an older in-flight cut, then take one cut for this request. Never
    // chase an endlessly dirty producer or accumulate per-change snapshots.
    this.#dirty = true;
    if (this.#publishing) await this.#publishing;
    if (this.#closed || this.#failure) throw this.#failure ?? new PublicationUnavailable();
    this.#publish();
    if (this.#publishing) await this.#publishing;
    if (this.#closed || this.#failure) throw this.#failure ?? new PublicationUnavailable();
  }

  async response(request: Request, expires: number, authorized: () => boolean, responseHeaders: Record<string, string>,
    target = new URL(request.url).pathname + new URL(request.url).search): Promise<Response> {
    const url = new URL(target, "http://publication.invalid");
    if (!isPublicationRoute(request.method, url.pathname)) throw new PublicationUnavailable(404, "Publication route not found");
    if (this.#active.size >= PUBLICATION_LIMITS.requests) throw new PublicationUnavailable(429, "Too many operator requests");
    if (expires <= Date.now() || !authorized() || request.signal.aborted) throw new PublicationUnavailable(401, "The local session expired");
    const completion = Promise.withResolvers<void>();
    const active: ActiveRequest = { abort: new AbortController(), done: completion.promise, finish: completion.resolve };
    this.#active.add(active);
    let ended = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    const transport = Promise.withResolvers<void>();
    const expectsStream = url.pathname === "/v1/events";
    let streaming = false;
    // Even an SSE request has a finite header/admission window. Only a genuine
    // successful event stream replaces it with idle and session-expiry bounds.
    const totalTimer = setTimeout(() => finish(new PublicationUnavailable(504, "Operator publication deadline expired")), PUBLICATION_LIMITS.requestMs);
    const expiryTimer = setTimeout(() => finish(new PublicationUnavailable(401, "The local session expired")), Math.max(1, expires - Date.now()));
    const aborted = () => finish(new PublicationUnavailable(499, "Operator request was aborted"));
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(totalTimer); clearTimeout(expiryTimer); clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", aborted);
      active.abort.abort();
      if (controller) { try { if (error) controller.error(error); else controller.close(); } catch {} }
      const cancelled = reader ? reader.cancel().catch(() => {}) : Promise.resolve();
      void Promise.all([cancelled, transport.promise]).finally(() => { this.#active.delete(active); active.finish(); });
    };
    request.signal.addEventListener("abort", aborted, { once: true });
    active.abort.signal.addEventListener("abort", () => { if (!ended) finish(new PublicationUnavailable()); }, { once: true });
    try {
      await Promise.race([
        this.#flush(),
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new PublicationUnavailable(
            expires <= Date.now() || !authorized() ? 401 : 503,
            expires <= Date.now() || !authorized() ? "The local session expired" : "Operator publication is unavailable",
          ));
          if (active.abort.signal.aborted) abort();
          else active.abort.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      if (ended || !authorized() || expires <= Date.now()) throw new PublicationUnavailable(401, "The local session expired");
      const privateHeaders = { ...this.#headers(), "x-publication-expires": String(expires) };
      const lastId = request.headers.get("last-event-id");
      if (lastId !== null) Object.assign(privateHeaders, { "last-event-id": lastId });
      const response = await fetch(this.#origin! + url.pathname + url.search, {
        method: request.method, headers: privateHeaders,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
        signal: active.abort.signal,
      });
      streaming = expectsStream && response.ok &&
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
      if (streaming) clearTimeout(totalTimer);
      transport.resolve();
      if (ended || !authorized() || expires <= Date.now()) { await response.body?.cancel(); throw new PublicationUnavailable(401, "The local session expired"); }
      if (!response.body) { finish(); return new Response(null, { status: response.status, headers: responseHeaders }); }
      reader = response.body.getReader();
      const bytes = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          if (ended) return;
          if (!authorized() || expires <= Date.now()) { finish(new PublicationUnavailable(401, "The local session expired")); return; }
          idleTimer = setTimeout(() => finish(new PublicationUnavailable(504, "Operator publication stream stalled")), PUBLICATION_LIMITS.streamIdleMs);
          try {
            const chunk = await reader!.read();
            clearTimeout(idleTimer);
            if (ended) return;
            if (!authorized() || expires <= Date.now()) { finish(new PublicationUnavailable(401, "The local session expired")); return; }
            if (chunk.done) finish(streaming ? new PublicationUnavailable() : undefined);
            else value.enqueue(chunk.value);
          } catch { finish(new PublicationUnavailable()); }
        },
        cancel() { finish(); return active.done; },
      }, { highWaterMark: 0 });
      const headers = { ...responseHeaders, "Content-Type": response.headers.get("content-type") ?? "application/json" };
      if (streaming) Object.assign(headers, { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      return new Response(bytes, { status: response.status, headers });
    } catch (error) {
      transport.resolve();
      finish();
      if (error instanceof PublicationUnavailable) throw error;
      throw new PublicationUnavailable();
    }
  }

  #fail(): void {
    if (this.#failure) return;
    this.#failure = new PublicationUnavailable();
    clearTimeout(this.#startupTimer);
    this.#ready.reject(this.#failure);
    this.#seedAbort?.abort();
    for (const active of this.#active) active.abort.abort();
    try { this.#child.kill("SIGKILL"); } catch { /* Actual close remains the drain barrier. */ }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    if (this.#scheduled) { clearImmediate(this.#scheduled); this.#scheduled = null; }
    this.#dirty = false;
    this.#fail();
    this.#closing = (async () => {
      await this.#drained.promise;
      await this.#publishing?.catch(() => {});
      await Promise.all([...this.#active].map(request => request.done));
    })();
    return this.#closing;
  }
}
