import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspectVideoFrame } from "./video.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import type { ActorFramePresentation } from "./actor-frame-codec.ts";
import { ACTOR_FRAME_LIMITS, ACTOR_FRAME_PROTOCOL_VERSION, actorFrameResponseSchema } from "./actor-frame-protocol.ts";

const workerPath = fileURLToPath(new URL("./actor-frame-worker.ts", import.meta.url));
const failure = () => new RuntimeFault("backend_unavailable", "Actor image worker could not complete; no local encoding was used");
export interface ActorFrameEncodingOptions { deadlineOsNs: bigint; signal?: AbortSignal }
interface OwnedEncoding {
  process: ChildProcess; drained: Promise<void>; stop: () => void;
}

/** Owns at most one inference encoding process, including startup and all pipes.
 * There is no frame queue, persistent global worker, local fallback or child fault authority.
 */
export class ActorFrameEncodingClient {
  #active: OwnedEncoding | null = null;
  #closed = false;
  snapshot() { return { closed: this.#closed, child_pid: this.#active?.process.pid ?? null, active: this.#active !== null }; }

  encode(frame: Uint8Array, options: ActorFrameEncodingOptions): Promise<ActorFramePresentation> {
    const receivedAt = Date.now(), now = osMonotonicNs();
    if (this.#closed || this.#active || options.signal?.aborted || !inspectVideoFrame(frame, receivedAt) ||
        typeof options.deadlineOsNs !== "bigint" || options.deadlineOsNs <= now) return Promise.reject(failure());
    // Capture once, before spawn and transport. Startup/EOF/response cannot renew it.
    const deadline = options.deadlineOsNs < now + BigInt(ACTOR_FRAME_LIMITS.jobMs) * 1_000_000n
      ? options.deadlineOsNs : now + BigInt(ACTOR_FRAME_LIMITS.jobMs) * 1_000_000n;
    const header = Buffer.from(JSON.stringify({ v: ACTOR_FRAME_PROTOCOL_VERSION, frame_bytes: frame.byteLength,
      received_at: receivedAt, deadline_os_ns: deadline.toString() }));
    if (header.length > ACTOR_FRAME_LIMITS.requestHeaderBytes) return Promise.reject(failure());
    const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(header.length);
    const completion = Promise.withResolvers<ActorFramePresentation>(), drain = Promise.withResolvers<void>();
    let processChild: ChildProcess;
    try {
      processChild = spawn(process.execPath, ["--no-env-file", workerPath], { cwd: path.dirname(workerPath),
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return Promise.reject(failure()); }
    let stopping = false, bytes = 0;
    const parts: Buffer[] = [];
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // kill before spawn can return false. The spawn listener repeats the kill
      // once the process has actually appeared; ownership ends only at close.
      try { processChild.kill("SIGKILL"); } catch { /* close owns settlement */ }
      processChild.stdin?.destroy(); processChild.stdout?.destroy();
    };
    const owned: OwnedEncoding = { process: processChild, drained: drain.promise, stop };
    this.#active = owned;
    const timer = setTimeout(stop, Math.max(1, Number((deadline - osMonotonicNs()) / 1_000_000n)));
    const abort = stop;
    options.signal?.addEventListener("abort", abort, { once: true });
    processChild.once("spawn", () => {
      if (stopping) {
        try { processChild.kill("SIGKILL"); } catch { /* close owns settlement */ }
      } else if (this.#closed || options.signal?.aborted || osMonotonicNs() >= deadline) stop();
    });
    processChild.on("error", stop);
    processChild.stdin?.on("error", stop);
    processChild.stdout?.on("error", stop);
    processChild.stdout?.on("data", (chunk: Buffer) => {
      if (stopping) return;
      bytes += chunk.length;
      if (bytes > ACTOR_FRAME_LIMITS.responseBytes) { stop(); return; }
      parts.push(chunk);
    });
    // Successful output alone is not completion: join true process close and
    // every stdio pipe before releasing the slot or publishing the presentation.
    processChild.once("close", (code, signal) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (this.#active === owned) this.#active = null;
      try {
        if (stopping || this.#closed || options.signal?.aborted || code !== 0 || signal !== null || osMonotonicNs() >= deadline)
          throw failure();
        const result = actorFrameResponseSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes))));
        if (result.worker_pid !== processChild.pid || result.worker_pid === process.pid ||
            result.data.length !== 4 * Math.ceil(result.encoded_bytes / 3) || osMonotonicNs() >= deadline) throw failure();
        // No native fault code, capture identity, scope or deadline comes from the child.
        completion.resolve({ data: result.data, encoded_bytes: result.encoded_bytes, sha256: result.sha256 });
      } catch { completion.reject(failure()); }
      finally { parts.length = 0; drain.resolve(); }
    });
    if (options.signal?.aborted || this.#closed || osMonotonicNs() >= deadline) stop();
    else {
      try {
        if (!processChild.stdin || !processChild.stdout) throw failure();
        processChild.stdin.write(prefix); processChild.stdin.write(header);
        // A view, not a full-frame clone or base64 envelope. The native packet
        // remains immutable and owned by its source for the duration of write.
        processChild.stdin.end(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      } catch { stop(); }
    }
    return completion.promise;
  }

  close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (!active) return Promise.resolve();
    active.stop();
    return active.drained;
  }
}
