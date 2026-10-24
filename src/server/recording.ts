import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { encodeNativeFramePng } from "./actor-frames.ts";
import { inspectVideoFrame } from "./video.ts";

const DEFAULT_LIMITS = { maxPendingRawBytes: 128 * 1024 * 1024, maxFrames: 12000,
  maxStoredFrameBytes: 32 * 1024 ** 3, maxDurationMs: 600000 };
async function createDurableArtifact(directory: string, name: string, content: string | Uint8Array) {
  const file = await open(path.join(directory, name), "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
interface Options {
  directory: string; bridge: { subscribeFrames(callback: (frame: Uint8Array) => void): () => void };
  identity: { episode_id: string; run_id: string; world_id: string; session_id: string };
  now?: () => number; monotonicNow?: () => number; onIncomplete(reason: string): void;
  limits?: Partial<typeof DEFAULT_LIMITS>; encode?: typeof encodeNativeFramePng;
}
export interface RecordingManifest {
  status: "complete" | "incomplete"; audio: "not_recorded"; delivered_frames: number; stored_frames: number;
  end_reason: string; index: string; concat: string; limitations: string[]; failures: string[];
}
/** Direct delivered-frame subscription, independent of spectator backpressure/latest selection. */
export class EpisodeRecorder {
  private readonly limits; private readonly now; private readonly monotonic;
  private readonly started: number; private readonly unsubscribe: () => void;
  private readonly ready; private readonly timer;
  private accepting = true; private delivered = 0; private stored = 0; private pending = 0; private bytes = 0;
  private active = 0; private tail: Promise<void> = Promise.resolve();
  private commits: Promise<void> = Promise.resolve();
  private queue: Array<{ frame: Uint8Array; received: number; monotonic: number; ordinal: number }> = [];
  private frames: Array<{ ordinal: number; file: string; capturedAt: number; sequence: number }> = [];
  private shape: string | null = null;
  private failures: string[] = [];
  private indexClosing = false;
  private drained = Promise.withResolvers<void>();
  private finished: Promise<RecordingManifest> | null = null;
  private replay: Promise<string> | null = null;
  constructor(private readonly options: Options) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }; this.now = options.now ?? Date.now;
    this.monotonic = options.monotonicNow ?? (() => performance.now()); this.started = this.now();
    this.ready = mkdir(options.directory, { recursive: true, mode: 0o700 }).then(() => open(path.join(options.directory, "frames.jsonl"), "ax", 0o600));
    this.unsubscribe = options.bridge.subscribeFrames(frame => this.deliver(frame));
    this.timer = setTimeout(() => this.fail("episode_duration_bound_reached"), this.limits.maxDurationMs);
    this.timer.unref?.();
    void this.ready.catch(() => this.fail("recording_index_persistence_failed"));
  }
  private append(value: unknown) {
    this.tail = this.tail.then(async () => { const file = await this.ready; await file.writeFile(JSON.stringify(value) + "\n"); })
      .catch(() => this.fail("recording_index_persistence_failed"));
  }
  private fail(reason: string) {
    if (this.failures.includes(reason)) return;
    const first = this.failures.length === 0;
    this.failures.push(reason); this.accepting = false; this.unsubscribe(); clearTimeout(this.timer);
    if (!this.indexClosing) this.append({ kind: "failure", reason, monotonic_ms: this.monotonic(), ...this.options.identity });
    if (first) this.options.onIncomplete(reason);
  }
  private deliver(frame: Uint8Array) {
    if (!this.accepting) return;
    this.delivered++;
    const received = this.now(), header = inspectVideoFrame(frame, received);
    if (!header) { this.fail("malformed_or_stale_delivered_frame"); return; }
    if (received - this.started > this.limits.maxDurationMs) { this.fail("episode_duration_bound_reached"); return; }
    if (this.delivered > this.limits.maxFrames) { this.fail("delivered_frame_count_bound_reached"); return; }
    if (this.pending + frame.byteLength > this.limits.maxPendingRawBytes) { this.fail("pending_raw_frame_queue_bound_reached"); return; }
    const shape = `${header.width}:${header.height}:${header.bottomUp}`;
    if (this.shape !== null && this.shape !== shape) { this.fail("frame_dimensions_or_orientation_changed"); return; }
    this.shape = shape;
    // GameBridge's decoder already gives subscribers immutable owned packets. No
    // copy/compression/file IO in the control callback; keep that shared owner.
    if (this.pending === 0) this.drained = Promise.withResolvers<void>();
    this.pending += frame.byteLength;
    this.queue.push({ frame, received, monotonic: this.monotonic(), ordinal: this.delivered });
    queueMicrotask(() => this.pump());
  }
  private pump() {
    while (this.active < 2 && this.queue.length) {
      const entry = this.queue.shift()!; this.active++;
      void this.persist(entry).catch(() => this.fail("frame_encoder_or_persistence_failed")).finally(() => {
        this.pending -= entry.frame.byteLength; this.active--; this.pump();
        if (!this.active && !this.queue.length) this.drained.resolve();
      });
    }
  }
  private persist(entry: { frame: Uint8Array; received: number; monotonic: number; ordinal: number }) {
    const encoding = (this.options.encode ?? encodeNativeFramePng)(entry.frame, entry.received);
    void encoding.catch(() => {});
    const commit = this.commits.then(async () => {
    const encoded = await encoding;
    if (this.bytes + encoded.png.length > this.limits.maxStoredFrameBytes) { this.fail("stored_frame_byte_bound_reached"); return; }
    this.bytes += encoded.png.length;
    await this.ready;
    const file = `frame-${String(entry.ordinal).padStart(6, "0")}.png`;
    await createDurableArtifact(this.options.directory, file, encoded.png);
    this.stored++; this.frames.push({ ordinal: entry.ordinal, file, capturedAt: encoded.capturedAt, sequence: encoded.sequence });
    const header = inspectVideoFrame(entry.frame, entry.received)!;
    // Encodes run concurrently, durable commits retain delivery order.
    this.append({ kind: "frame", ordinal: entry.ordinal, file, sequence: encoded.sequence,
      captured_at: encoded.capturedAt, received_monotonic_ms: entry.monotonic, width: encoded.width, height: encoded.height,
      bottom_up: header.bottomUp, png_orientation: "top_down", ...this.options.identity });
    });
    this.commits = commit.catch(() => {});
    return commit;
  }
  finish(input: { endedAt: number; reason: string }): Promise<RecordingManifest> {
    if (this.finished) return this.finished;
    this.accepting = false; this.unsubscribe(); clearTimeout(this.timer);
    this.finished = this.finalize(input); return this.finished;
  }
  private async finalize(input: { endedAt: number; reason: string }): Promise<RecordingManifest> {
    if (this.active || this.queue.length) await this.drained.promise;
    this.frames.sort((a, b) => a.ordinal - b.ordinal);
    // This finite (maxFrames) timeline is independent of an index-write failure,
    // so other evidence and an incomplete manifest can still be retained.
    await this.tail;
    const records = this.frames;
    for (let i = 1; i < records.length; i++) {
      const prior = records[i - 1]!, next = records[i]!;
      const delta = next.capturedAt - prior.capturedAt;
      if (delta < 0 || next.sequence <= prior.sequence) this.fail("nonmonotonic_native_capture_timeline");
      if (next.sequence !== prior.sequence + 1 || delta > 100) this.append({ kind: "upstream_gap", previous_sequence: prior.sequence,
        sequence: next.sequence, missing_sequences: Math.max(0, next.sequence - prior.sequence - 1), capture_delta_ms: delta });
    }
    if (!this.frames.length) this.fail("no_delivered_frames_stored");
    const concat = ["ffconcat version 1.0"];
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i]!, end = this.frames[i + 1]?.capturedAt ?? input.endedAt;
      if (end < frame.capturedAt) this.fail("recording_end_precedes_capture");
      concat.push(`file '${frame.file}'`, `duration ${Math.max(0, end - frame.capturedAt) / 1000}`);
    }
    if (this.frames.length) concat.push(`file '${this.frames.at(-1)!.file}'`);
    let persistenceFailure: unknown;
    try { await createDurableArtifact(this.options.directory, "replay.ffconcat", concat.join("\n") + "\n"); }
    catch (error) { persistenceFailure = error; this.fail("recording_concat_persistence_failed"); }
    finally {
      // The index owns a real handle independently of concat/manifest success.
      // Retain its end/failure evidence and close even when another artifact fails.
      this.append({ kind: "end", ended_at: input.endedAt, reason: input.reason, ...this.options.identity });
      await this.tail;
      this.indexClosing = true;
      try { const index = await this.ready; try { await index.sync(); } finally { await index.close(); } }
      catch (error) { persistenceFailure ??= error; this.fail("recording_index_flush_failed"); }
    }
    const manifest: RecordingManifest = { status: this.failures.length ? "incomplete" : "complete", audio: "not_recorded",
      delivered_frames: this.delivered, stored_frames: this.stored, end_reason: input.reason, index: "frames.jsonl", concat: "replay.ffconcat",
      failures: [...this.failures], limitations: ["Every frame delivered to this recorder is retained unless evidence is explicitly incomplete. The upstream native producer can omit renders.",
        "Native capture wall time and host monotonic receipt time are distinct; no capture-life synchronization proof exists.", "Audio is not recorded."] };
    try { await createDurableArtifact(this.options.directory, "recording-manifest.json", JSON.stringify(manifest, null, 2)); }
    catch (error) { throw persistenceFailure ?? error; }
    if (persistenceFailure) throw persistenceFailure;
    return manifest;
  }
  /** Offline optional stage: PNG/index/concat survive FFmpeg failure. No fixed-rate wait compression. */
  renderReplay(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    if (!this.replay) this.replay = this.render(options);
    return this.replay;
  }
  private async render({ signal, timeoutMs = 120000 }: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    if (!this.finished) throw new Error("Finish capture before offline replay rendering");
    signal?.throwIfAborted();
    await this.finished;
    signal?.throwIfAborted();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Replay timeout must be finite and positive");
    const closed = Promise.withResolvers<number | null>();
    const child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-n", "-f", "concat", "-safe", "1", "-i", "replay.ffconcat", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "replay.mp4"], { cwd: this.options.directory, stdio: "ignore" });
    let failure: Error | undefined;
    const terminate = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => terminate(signal?.reason instanceof Error ? signal.reason : new Error("Offline replay rendering interrupted"));
    const timer = setTimeout(() => terminate(new Error("Offline replay rendering deadline reached")), timeoutMs);
    // A spawn error also emits close. Neither abort nor timeout may settle the
    // public promise until that owned-process close barrier has actually fired.
    child.once("error", () => { failure ??= new Error("Offline replay renderer unavailable"); });
    child.once("close", closed.resolve);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const code = await closed.promise;
      if (failure) throw failure;
      if (code !== 0) throw new Error("Offline replay rendering failed; original evidence retained");
      return "replay.mp4";
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}
