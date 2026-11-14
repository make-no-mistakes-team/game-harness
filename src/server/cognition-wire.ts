import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export const COGNITION_LIMITS = Object.freeze({ frameBytes: 4 * 1024 * 1024, pending: 16,
  queuedBytes: 8 * 1024 * 1024, metadata: 128, metadataBytes: 2 * 1024 * 1024,
  startupMs: 15_000, closeGraceMs: 250, cancellationDrainMs: 1_000, contextMs: 5_000 });
const frameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("call"), id: z.number().int().positive().safe(), method: z.string().min(1).max(64), body: z.unknown() }).strict(),
  z.object({ kind: z.literal("result"), id: z.number().int().positive().safe(), ok: z.boolean(), body: z.unknown().optional() }).strict(),
]);
export type CognitionFrame = z.infer<typeof frameSchema>;
const failure = () => new Error("Cognition transport unavailable");

/** Private bounded pipes. Errors intentionally carry neither native brands nor provider text. */
export class CognitionWire {
  #next = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #active = new Set<Promise<void>>();
  #writing: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #bytes = 0;
  #parts: Buffer[] = [];
  #closed = false;
  #ended = Promise.withResolvers<void>();
  #lastIncoming = 0;
  readonly ended = this.#ended.promise;
  constructor(private readonly input: Readable, private readonly output: Writable,
    private readonly handle: (method: string, body: unknown) => unknown | Promise<unknown>,
    private readonly failed: () => void) {
    input.on("data", (chunk: Buffer) => { try { this.#read(chunk); } catch { this.fail(); } });
    input.once("end", () => { if (this.#bytes) this.fail(); else this.#end(); });
    input.once("error", () => this.fail());
    output.on("error", () => this.fail());
  }
  async call<T>(method: string, body: unknown): Promise<T> {
    if (this.#closed || this.#pending.size >= COGNITION_LIMITS.pending) throw failure();
    const id = this.#next++, response = Promise.withResolvers<unknown>();
    this.#pending.set(id, response);
    void response.promise.catch(() => {});
    try { await this.#send({ kind: "call", id, method, body }); }
    catch { this.#pending.delete(id); response.reject(failure()); throw failure(); }
    return await response.promise as T;
  }
  async flush(): Promise<void> { await this.#writing; if (this.#closed) throw failure(); }
  /** Join actual inbound handlers and write callbacks, not merely canceled callers. */
  async drain(): Promise<void> {
    while (this.#active.size) await Promise.allSettled([...this.#active]);
    // Delivery failure remains visible to call()/flush(). It is not evidence
    // of a live writer after the owner has joined the real process/pipes.
    await Promise.allSettled([this.#writing]);
  }
  end(): void { this.output.end(); }
  fail(): void { if (this.#closed) return; this.#end(); this.failed(); }
  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(failure());
    this.#pending.clear(); this.#ended.resolve();
  }
  #send(frame: CognitionFrame): Promise<void> {
    const data = JSON.stringify(frame) + "\n", bytes = Buffer.byteLength(data);
    if (this.#closed || bytes > COGNITION_LIMITS.frameBytes || this.#queuedBytes + bytes > COGNITION_LIMITS.queuedBytes) {
      this.fail(); return Promise.reject(failure());
    }
    this.#queuedBytes += bytes;
    const write = this.#writing.then(() => {
      const completion = Promise.withResolvers<void>();
      if (this.#closed || this.output.destroyed) completion.reject(failure());
      else this.output.write(data, error => error ? completion.reject(failure()) : completion.resolve());
      return completion.promise;
    }).finally(() => { this.#queuedBytes -= bytes; });
    this.#writing = write;
    void write.catch(() => this.fail());
    return write;
  }
  #read(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), through = end < 0 ? chunk.length : end + 1;
      const length = through - offset;
      if (this.#bytes + length > COGNITION_LIMITS.frameBytes) throw failure();
      this.#parts.push(Buffer.from(chunk.subarray(offset, through))); this.#bytes += length; offset = through;
      if (end < 0) break;
      const data = Buffer.concat(this.#parts, this.#bytes); this.#parts = []; this.#bytes = 0;
      const frame = frameSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, data.length - 1))));
      if (frame.kind === "result") {
        const pending = this.#pending.get(frame.id);
        if (!pending) throw failure();
        this.#pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.body); else pending.reject(failure());
      } else {
        if (frame.id <= this.#lastIncoming || this.#active.size >= COGNITION_LIMITS.pending) throw failure();
        this.#lastIncoming = frame.id;
        const work = Promise.resolve().then(() => this.handle(frame.method, frame.body)).then(
          body => this.#send({ kind: "result", id: frame.id, ok: true, body }),
          () => this.#send({ kind: "result", id: frame.id, ok: false }),
        );
        this.#active.add(work);
        void work.finally(() => this.#active.delete(work)).catch(() => this.fail());
      }
    }
  }
}
