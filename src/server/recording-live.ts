import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizeRecordingLimits } from "../shared/evidence-limits.ts";
import type { NativeVideoHeader } from "../shared/video.ts";
import { inspectVideoFrame } from "./video.ts";
import { LiveSegmentEncoder } from "./recording-stream.ts";
import type { LiveRecordingManifest, RecordingOptions, RecordingSegment, RecorderHealth } from "./recording.ts";

interface Entry { frame: Uint8Array; header: NativeVideoHeader; receivedMonotonic: number; ordinal: number }
interface Segment { encoder: LiveSegmentEncoder; file: string; start: number; entries: Omit<Entry, "frame">[] }
async function durable(directory: string, name: string, value: unknown) {
  const file = await open(path.join(directory, name), "wx", 0o600);
  try { await file.writeFile(typeof value === "string" ? value : JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
}
async function digest(filename: string, signal?: AbortSignal, deadline = Infinity) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, { signal })) {
    if (performance.now() >= deadline) throw new Error("Replay assembly deadline reached");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export class LiveEpisodeRecorder {
  private readonly limits;
  private readonly now;
  private readonly monotonic;
  private readonly started: number;
  private readonly ready: Promise<FileHandle>;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private accepting = true;
  private delivered = 0;
  private stored = 0;
  private pending = 0;
  private peak = 0;
  private bytes = 0;
  private failures: string[] = [];
  private queue: Entry[] = [];
  private working = false;
  private work: Promise<void> = Promise.resolve();
  private indexTail: Promise<void> = Promise.resolve();
  private indexClosing = false;
  private last: Entry | undefined;
  private previous: NativeVideoHeader | undefined;
  private firstCapture: number | null = null;
  private lastCapture: number | null = null;
  private segment: Segment | undefined;
  private segments: RecordingSegment[] = [];
  private segmentOrdinal = 0;
  private encoderBroken = false;
  private finished: Promise<LiveRecordingManifest> | undefined;
  private replay: Promise<string> | undefined;
  constructor(private readonly options: RecordingOptions) {
    this.limits = normalizeRecordingLimits(options.limits);
    this.now = options.now ?? Date.now; this.monotonic = options.monotonicNow ?? (() => performance.now());
    this.started = this.now();
    this.ready = mkdir(options.directory, { recursive: true, mode: 0o700 }).then(() => open(path.join(options.directory, "frames.jsonl"), "ax", 0o600));
    this.unsubscribe = options.bridge.subscribeFrames(frame => this.deliver(frame));
    this.timer = setTimeout(() => this.fail("episode_duration_bound_reached"), this.limits.maxDurationMs); this.timer.unref?.();
    void this.ready.catch(() => this.fail("recording_index_persistence_failed"));
  }
  health(): RecorderHealth {
    return { accepting: this.accepting, delivered_frames: this.delivered, stored_frames: this.stored,
      pending_raw_bytes: this.pending, peak_pending_raw_bytes: this.peak, active_encoders: this.segment ? 1 : 0,
      queued_frames: this.queue.length, stored_png_bytes: 0, stored_encoded_bytes: this.bytes, failures: [...this.failures] };
  }
  private append(value: unknown) {
    this.indexTail = this.indexTail.then(async () => { const file = await this.ready; await file.writeFile(JSON.stringify(value) + "\n"); })
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
    if (!Number.isSafeInteger(header.capturedAt)) { this.fail("nonintegral_native_capture_timestamp"); return; }
    if (received - this.started > this.limits.maxDurationMs) { this.fail("episode_duration_bound_reached"); return; }
    if (this.delivered > this.limits.maxFrames) { this.fail("delivered_frame_count_bound_reached"); return; }
    if (this.pending + frame.byteLength > this.limits.maxPendingRawBytes) { this.fail("pending_raw_frame_queue_bound_reached"); return; }
    if (this.previous) {
      if (this.previous.width !== header.width || this.previous.height !== header.height || this.previous.bottomUp !== header.bottomUp) {
        this.fail("frame_dimensions_or_orientation_changed"); return;
      }
      if (header.capturedAt < this.previous.capturedAt || header.sequence <= this.previous.sequence) {
        this.fail("nonmonotonic_native_capture_timeline"); return;
      }
      const delta = header.capturedAt - this.previous.capturedAt;
      if (header.sequence !== this.previous.sequence + 1 || delta > 100)
        this.append({ kind: "upstream_gap", previous_sequence: this.previous.sequence, sequence: header.sequence,
          missing_sequences: Math.max(0, header.sequence - this.previous.sequence - 1), capture_delta_ms: delta });
    }
    this.previous = header;
    // The immutable GameBridge packet is shared, not copied. The held terminal
    // frame remains included in pending until the next frame or final drain.
    this.pending += frame.byteLength; this.peak = Math.max(this.peak, this.pending);
    this.queue.push({ frame, header, receivedMonotonic: this.monotonic(), ordinal: this.delivered });
    if (!this.working) {
      this.working = true;
      this.work = Promise.resolve().then(() => this.pump()).finally(() => { this.working = false; });
    }
  }
  private async pump() {
    while (this.queue.length) {
      const entry = this.queue.shift()!;
      try {
        if (this.encoderBroken) {
          this.append({ kind: "frame_not_stored", ordinal: entry.ordinal, sequence: entry.header.sequence, reason: "encoder_failed", ...this.options.identity });
          continue;
        }
        await this.ready;
        // Each encoder starts at an actual frame boundary. Explicit endpoint
        // duplication preserves the preceding hold; concat outpoints exclude
        // that synthetic duplicate when another real segment follows.
        if (this.segment && entry.header.capturedAt - this.segment.start >= 5000)
          await this.closeSegment(entry.header.capturedAt);
        if (this.encoderBroken) continue;
        if (!this.segment) {
          const file = `segment-${String(++this.segmentOrdinal).padStart(6, "0")}.mkv`;
          const encoder = await LiveSegmentEncoder.create(path.join(this.options.directory, file), entry.header, bytes => {
            if (this.bytes + bytes > this.limits.maxStoredFrameBytes) return false;
            this.bytes += bytes; return true;
          }, reason => { this.encoderBroken = true; this.fail(reason); }, this.options.encoderDrainTimeoutMs ?? 10000);
          this.segment = { encoder, file, start: entry.header.capturedAt, entries: [] };
        }
        await this.segment.encoder.frame(entry.frame, entry.header, entry.header.capturedAt - this.segment.start);
        this.segment.entries.push({ header: entry.header, ordinal: entry.ordinal, receivedMonotonic: entry.receivedMonotonic });
        if (this.last) this.pending -= this.last.frame.byteLength;
        this.last = entry;
      } catch {
        this.encoderBroken = true; this.fail("frame_encoder_or_persistence_failed");
      } finally {
        if (this.last !== entry) this.pending -= entry.frame.byteLength;
      }
    }
  }
  private async closeSegment(endedAt: number) {
    const segment = this.segment;
    if (!segment) return;
    let finalized = true;
    try {
      if (this.last && endedAt > this.last.header.capturedAt && !this.encoderBroken)
        await segment.encoder.frame(this.last.frame, this.last.header, endedAt - segment.start);
    } catch { finalized = false; this.fail("live_encoder_terminal_hold_failed"); }
    try { await segment.encoder.finish(); }
    catch { finalized = false; this.encoderBroken = true; this.fail("live_segment_finalization_failed"); }
    finally {
      this.segment = undefined;
      if (this.last) { this.pending -= this.last.frame.byteLength; this.last = undefined; }
    }
    const filename = path.join(this.options.directory, segment.file);
    const bytes = (await stat(filename)).size;
    const record: RecordingSegment = { file: segment.file, status: finalized ? "finalized" : "incomplete",
      first_capture_at: segment.start, ended_at: endedAt, frames: segment.entries.length, bytes, sha256: await digest(filename) };
    this.segments.push(record);
    // Only a real finalized encoder/file barrier makes frames stored evidence.
    if (finalized) for (const entry of segment.entries) {
      this.stored++; this.firstCapture ??= entry.header.capturedAt; this.lastCapture = entry.header.capturedAt;
      this.append({ kind: "frame", ordinal: entry.ordinal, segment: segment.file, segment_pts_ms: entry.header.capturedAt - segment.start,
        sequence: entry.header.sequence, captured_at: entry.header.capturedAt, received_monotonic_ms: entry.receivedMonotonic,
        width: entry.header.width, height: entry.header.height, bottom_up: entry.header.bottomUp, video_orientation: "top_down",
        capture: entry.header.capture, ...this.options.identity });
    }
    this.append({ kind: "segment", ...record, ...this.options.identity });
    await this.indexTail;
    try { await (await this.ready).sync(); }
    catch { this.fail("recording_index_flush_failed"); }
    this.bytes = this.segments.reduce((sum, item) => sum + item.bytes, 0);
  }
  finish(input: { endedAt: number; reason: string }): Promise<LiveRecordingManifest> {
    if (this.finished) return this.finished;
    this.accepting = false; this.unsubscribe(); clearTimeout(this.timer);
    this.finished = this.finalize(input); return this.finished;
  }
  private async finalize(input: { endedAt: number; reason: string }): Promise<LiveRecordingManifest> {
    await this.work;
    let endedAt = input.endedAt;
    if (!Number.isSafeInteger(endedAt) || endedAt < (this.previous?.capturedAt ?? 0)) {
      this.fail("recording_end_precedes_capture"); endedAt = this.previous?.capturedAt ?? 0;
    }
    let persistenceFailure: unknown;
    try { await this.closeSegment(endedAt); }
    catch (error) { persistenceFailure = error; this.fail("live_segment_persistence_failed"); }
    if (!this.stored) this.fail("no_delivered_frames_stored");
    const finalized = this.segments.filter(segment => segment.status === "finalized");
    const lines = ["ffconcat version 1.0"];
    for (const [index, segment] of finalized.entries()) {
      const duration = (segment.ended_at - segment.first_capture_at) / 1000;
      lines.push(`file '${segment.file}'`, `duration ${duration}`);
      if (index < finalized.length - 1) lines.push(`outpoint ${duration}`);
    }
    const concat = lines.join("\n") + "\n", concatSha256 = createHash("sha256").update(concat).digest("hex");
    try { await durable(this.options.directory, "replay.ffconcat", concat); }
    catch (error) { persistenceFailure ??= error; this.fail("recording_concat_persistence_failed"); }
    finally {
      this.append({ kind: "end", ended_at: input.endedAt, reason: input.reason, ...this.options.identity });
      await this.indexTail; this.indexClosing = true;
      try { const file = await this.ready; try { await file.sync(); } finally { await file.close(); } }
      catch (error) { persistenceFailure ??= error; this.fail("recording_index_flush_failed"); }
    }
    const manifest: LiveRecordingManifest = { schema_version: 2, capture_mode: "live_compressed", codec: "h264", video_orientation: "top_down",
      nominal_capture_hz: 30, limits: this.limits, health: this.health(), segments: this.segments, concat_sha256: concatSha256,
      timing: { first_capture_at: this.firstCapture, last_capture_at: this.lastCapture, ended_at: input.endedAt,
        capture_duration_ms: this.firstCapture !== null && this.lastCapture !== null ? this.lastCapture - this.firstCapture : null,
        final_hold_ms: this.lastCapture !== null ? input.endedAt - this.lastCapture : null },
      status: this.failures.length ? "incomplete" : "complete", audio: "not_recorded", delivered_frames: this.delivered,
      stored_frames: this.stored, end_reason: input.reason, index: "frames.jsonl", concat: "replay.ffconcat", failures: [...this.failures],
      limitations: ["Live H.264 CRF18 video is not exact-pixel evidence; model-seen journal images remain unchanged. Use explicit finite lossless_png for frozen pixel protocols.",
        "Every admitted frame is submitted at native capture PTS without fixed-rate resampling. Upstream producer gaps remain visible; final holds use a synthetic endpoint image.",
        "Frames are durable only in finalized segments; an interrupted or failed active segment is explicitly incomplete. Segments close at the next capture boundary after five seconds.",
        "Capture scope, orientation and pose diagnostics are provenance, not synchronized structured-observation authority. Native wall and host monotonic clocks remain distinct. Audio is not recorded."] };
    try { await durable(this.options.directory, "recording-manifest.json", manifest); }
    catch (error) { throw persistenceFailure ?? error; }
    if (persistenceFailure) throw persistenceFailure;
    return manifest;
  }
  renderReplay(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    if (!this.replay) this.replay = (async () => {
      if (!this.finished) throw new Error("Finish capture before replay assembly");
      options.signal?.throwIfAborted();
      const manifest = await this.finished;
      return renderLiveReplay({ ...options, directory: this.options.directory, manifest, concatSha256: manifest.concat_sha256 });
    })();
    return this.replay;
  }
}

/** Remux already-compressed segments, never decode/reencode their capture timeline. */
export async function renderLiveReplay({ directory, manifest, concatSha256, signal, timeoutMs = 120000 }: {
  directory: string; manifest: LiveRecordingManifest; concatSha256: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<string> {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Replay timeout must be finite and positive");
  const deadline = performance.now() + timeoutMs;
  if (manifest.concat_sha256 !== concatSha256 || createHash("sha256").update(await readFile(path.join(directory, manifest.concat), { signal })).digest("hex") !== concatSha256)
    throw new Error("Recording concat changed after finalization; original evidence retained");
  if (!manifest.segments.length || manifest.segments.some(segment => segment.status !== "finalized"))
    throw new Error("Incomplete segments cannot be assembled as a canonical replay");
  let storedBytes = 0;
  for (const segment of manifest.segments) {
    if (!/^segment-\d{6}\.mkv$/.test(segment.file)) throw new Error("Invalid recording segment path");
    const filename = path.join(directory, segment.file);
    if (await digest(filename, signal, deadline) !== segment.sha256) throw new Error("Recording segment changed after finalization");
    storedBytes += (await stat(filename)).size;
  }
  signal?.throwIfAborted();
  if (performance.now() >= deadline) throw new Error("Replay assembly deadline reached");
  const file = await open(path.join(directory, "replay.mp4"), "wx", 0o600);
  const closed = Promise.withResolvers<void>();
  let failure: Error | undefined;
  const child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file",
    "-i", manifest.concat, "-map", "0:v:0", "-c:v", "copy", "-fps_mode", "passthrough", "-movflags", "frag_keyframe+empty_moov",
    "-f", "mp4", "pipe:1"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"] });
  const terminate = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
  const abort = () => terminate(signal?.reason instanceof Error ? signal.reason : new Error("Replay assembly interrupted"));
  const timer = setTimeout(() => terminate(new Error("Replay assembly deadline reached")), Math.max(1, deadline - performance.now()));
  child.once("error", () => terminate(new Error("Replay assembler unavailable")));
  child.once("close", code => { if (code !== 0) failure ??= new Error("Replay assembly failed; compressed segments retained"); closed.resolve(); });
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const output = (async () => {
    try {
      for await (const data of child.stdout) {
        const chunk = data as Buffer;
        if (storedBytes + chunk.length > manifest.limits.maxStoredFrameBytes) {
          terminate(new Error("Encoded recording byte bound reached during replay assembly")); break;
        }
        await file.writeFile(chunk); storedBytes += chunk.length;
      }
    } catch { terminate(new Error("Replay persistence failed; compressed segments retained")); }
  })();
  try {
    await closed.promise; await output;
    if (failure) throw failure;
    await file.sync(); return "replay.mp4";
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); await file.close(); }
}
