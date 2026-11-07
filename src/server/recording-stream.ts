import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import type { NativeVideoHeader } from "../shared/video.ts";

// A minimal streaming Matroska writer. Each raw RGBA packet has its own native
// millisecond PTS; unlike rawvideo/image2pipe, it cannot erase capture pauses.
function size(value: number) {
  for (let width = 1; width <= 8; width++) {
    if (BigInt(value) < (1n << BigInt(width * 7)) - 1n) {
      const result = Buffer.alloc(width); let bits = BigInt(value) | (1n << BigInt(width * 7));
      for (let index = width - 1; index >= 0; index--) { result[index] = Number(bits & 255n); bits >>= 8n; }
      return result;
    }
  }
  throw new RangeError("Matroska element exceeds supported length");
}
function id(value: number) {
  const width = Math.ceil(Math.log2(value + 1) / 8), bytes = Buffer.alloc(width);
  bytes.writeUIntBE(value, 0, width); return bytes;
}
function element(tag: number, content: Uint8Array) { return Buffer.concat([id(tag), size(content.byteLength), content]); }
function uint(tag: number, value: number) {
  const width = Math.max(1, Math.ceil(Math.log2(value + 1) / 8)), bytes = Buffer.alloc(width);
  bytes.writeUIntBE(value, 0, width); return element(tag, bytes);
}
function text(tag: number, value: string) { return element(tag, Buffer.from(value)); }
function master(tag: number, ...children: Uint8Array[]) { return element(tag, Buffer.concat(children)); }
function header(width: number, height: number) {
  const bitmap = Buffer.alloc(40);
  bitmap.writeUInt32LE(40, 0); bitmap.writeInt32LE(width, 4); bitmap.writeInt32LE(height, 8);
  bitmap.writeUInt16LE(1, 12); bitmap.writeUInt16LE(32, 14); bitmap.write("RGBA", 16, "ascii");
  bitmap.writeUInt32LE(width * height * 4, 20);
  return Buffer.concat([
    master(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8),
      text(0x4282, "matroska"), uint(0x4287, 4), uint(0x4285, 2)),
    // Unknown-sized Segment is required for a nonseekable stream.
    id(0x18538067), Buffer.from([1, 255, 255, 255, 255, 255, 255, 255]),
    master(0x1549a966, uint(0x2ad7b1, 1000000), text(0x4d80, "GameHarness"), text(0x5741, "GameHarness")),
    master(0x1654ae6b, master(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1),
      text(0x86, "V_MS/VFW/FOURCC"), element(0x63a2, bitmap), uint(0x23e383, 1000000),
      master(0xe0, uint(0xb0, width), uint(0xba, height)))),
  ]);
}
function packetPrefix(pts: number, bytes: number) {
  const timestamp = uint(0xe7, pts), block = Buffer.concat([id(0xa3), size(bytes + 4), Buffer.from([0x81, 0, 0, 0x80])]);
  return Buffer.concat([id(0x1f43b675), size(timestamp.length + block.length + bytes), timestamp, block]);
}

/** Owns the actual encoder process, output stream, file handle and close barrier. */
export class LiveSegmentEncoder {
  private failure: Error | undefined;
  private readonly closed = Promise.withResolvers<void>();
  private readonly output: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private bytes = 0;
  private ending = false;
  private drain: Promise<void> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private constructor(private readonly file: FileHandle, shape: NativeVideoHeader,
    private readonly onBytes: (bytes: number) => boolean, private readonly onFailure: (reason: string) => void,
    private readonly drainTimeoutMs: number) {
    this.child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-filter_threads", "1", "-threads", "1",
      "-thread_queue_size", "1", "-probesize", "32", "-analyzeduration", "0", "-f", "matroska", "-i", "pipe:0", "-an",
      ...(shape.bottomUp ? ["-vf", "vflip"] : []), "-fps_mode", "passthrough", "-enc_time_base", "1/1000",
      "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "18", "-bf", "0",
      "-pix_fmt", shape.width % 2 || shape.height % 2 ? "yuv444p" : "yuv420p", "-flush_packets", "1", "-f", "matroska", "pipe:1"],
    { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume(); // Never let diagnostics backpressure strand ownership.
    this.child.stdin.on("error", () => this.stop(new Error("Live encoder input failed"), "live_encoder_input_failed"));
    this.child.once("error", () => this.stop(new Error("Live encoder unavailable"), "live_encoder_unavailable"));
    this.child.once("close", code => {
      if (code !== 0 || !this.ending) this.stop(new Error("Live encoder stopped unexpectedly"), "live_encoder_failed");
      this.closed.resolve();
    });
    this.output = this.consume();
    void this.write(header(shape.width, shape.height)).catch(() => {});
  }
  static async create(filename: string, shape: NativeVideoHeader, onBytes: (bytes: number) => boolean,
    onFailure: (reason: string) => void, drainTimeoutMs: number) {
    const file = await open(filename, "wx", 0o600);
    try { return new LiveSegmentEncoder(file, shape, onBytes, onFailure, drainTimeoutMs); }
    catch (error) { await file.close(); throw error; }
  }
  private async consume() {
    try {
      for await (const chunk of this.child.stdout) {
        const data = chunk as Buffer;
        if (!this.onBytes(data.length)) {
          this.stop(new Error("Encoded recording byte bound reached"), "stored_frame_byte_bound_reached");
          break;
        }
        await this.file.writeFile(data); this.bytes += data.length;
      }
    } catch { this.stop(new Error("Live segment output persistence failed"), "live_encoder_output_persistence_failed"); }
  }
  private stop(error: Error, reason: string) {
    if (this.failure) return;
    this.failure = error; this.child.kill("SIGKILL"); this.child.stdin.destroy();
    this.onFailure(reason);
    // Failure owns the file drain even if its caller has not reached finish.
    queueMicrotask(() => { void this.finish().catch(() => {}); });
  }
  private write(bytes: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const completion = Promise.withResolvers<void>();
    // Time only blocked IO, not an idle capture interval: a legitimate long
    // producer pause must remain a presentation gap rather than an encoder fault.
    const timer = setTimeout(() => this.stop(new Error("Live encoder input stalled"), "live_encoder_drain_deadline_reached"), this.drainTimeoutMs);
    timer.unref?.();
    this.child.stdin.write(bytes, error => {
      clearTimeout(timer);
      if (error || this.failure) completion.reject(this.failure ?? error);
      else completion.resolve();
    });
    return completion.promise;
  }
  async frame(frame: Uint8Array, shape: NativeVideoHeader, pts: number) {
    if (!Number.isSafeInteger(pts) || pts < 0) throw new RangeError("Live recording PTS must be nonnegative integer milliseconds");
    await this.write(packetPrefix(pts, shape.width * shape.height * 4));
    await this.write(frame.subarray(shape.headerBytes));
  }
  /** Idempotent close; neither an error nor a deadline bypasses the real close. */
  finish(): Promise<void> {
    if (this.drain) return this.drain;
    this.ending = true;
    this.watchdog = setTimeout(() => this.stop(new Error("Live encoder drain deadline reached"), "live_encoder_drain_deadline_reached"), this.drainTimeoutMs);
    this.child.stdin.end();
    this.drain = (async () => {
      try {
        await this.closed.promise; await this.output;
        if (this.failure) throw this.failure;
        await this.file.sync();
      } finally {
        clearTimeout(this.watchdog);
        await this.file.close();
      }
    })();
    return this.drain;
  }
  get storedBytes() { return this.bytes; }
}
