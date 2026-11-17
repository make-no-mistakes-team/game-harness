import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeRecorder, renderEpisodeReplay } from "../src/server/recording.ts";
import { nativeFrame } from "./helpers/native-frame.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(limits = {}, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "live-recording-")); roots.push(directory);
  let listener: ((frame: Uint8Array) => void) | undefined, now = 10000;
  const failures: string[] = [];
  const incomplete = Promise.withResolvers<string>();
  const recorder = new EpisodeRecorder({ directory, limits, ...extra,
    identity: { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" },
    bridge: { subscribeFrames(callback) { listener = callback; return () => { listener = undefined; }; } },
    now: () => now, monotonicNow: () => now - 10000, onIncomplete: reason => { failures.push(reason); incomplete.resolve(reason); } });
  return { directory, recorder, failures, incomplete: incomplete.promise, subscribed: () => listener !== undefined,
    packet(frame: Uint8Array, receivedAt: number) { now = receivedAt; listener?.(frame); },
    emit(sequence: number, offset: number, bottomUp = false) {
      now = 10010 + offset;
      listener?.(nativeFrame({ sequence, capturedAt: 10000 + offset, bottomUp }));
    } };
}
async function binaryCommand(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  // Real child-process deadlock containment, not a guessed synchronization wait.
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`);
    return Buffer.from(stdout);
  } finally { clearTimeout(timer); await child.exited; }
}
async function command(args: string[], cwd: string) { return (await binaryCommand(args, cwd)).toString("utf8"); }
async function timestamps(directory: string, media: string) {
  const probe = JSON.parse(await command(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_format",
    "-show_entries", "frame=best_effort_timestamp_time:format=duration", "-of", "json", media], directory));
  return { pts: probe.frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time)),
    duration: Number(probe.format.duration) };
}

test("default capture encodes irregular native PTS live with no PNG spool and preserves terminal hold", async () => {
  const f = await fixture();
  f.emit(1, 0); f.emit(2, 33); f.emit(4, 846);
  const manifest = await f.recorder.finish({ endedAt: 10903, reason: "operator_stop" });
  expect(f.subscribed()).toBe(false);
  expect(manifest).toMatchObject({ schema_version: 2, capture_mode: "live_compressed", status: "complete", stored_frames: 3,
    timing: { capture_duration_ms: 846, final_hold_ms: 57 }, health: { pending_raw_bytes: 0, active_encoders: 0, stored_png_bytes: 0 } });
  expect((await readdir(f.directory)).filter(name => name.endsWith(".png"))).toEqual([]);
  const records = (await readFile(join(f.directory, manifest.index), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(records.filter(record => record.kind === "frame").map(record => [record.sequence, record.captured_at, record.video_orientation])).toEqual(
    [[1, 10000, "top_down"], [2, 10033, "top_down"], [4, 10846, "top_down"]]);
  expect(records.find(record => record.kind === "frame").capture).toMatchObject({ schema_version: 1, life_id: 0 });
  expect(records).toContainEqual(expect.objectContaining({ kind: "upstream_gap", missing_sequences: 1, capture_delta_ms: 813 }));
  const media = await f.recorder.renderReplay();
  const probe = await timestamps(f.directory, media);
  expect(probe.pts).toEqual([0, .033, .846, .903]);
  expect(Math.abs(probe.duration - .903)).toBeLessThanOrEqual(.005);
  await command(["ffmpeg", "-v", "error", "-i", media, "-f", "null", "-"], f.directory);
}, 20000);

test("finalized compressed segments recover independently and canonical replay retains gaps across segment boundaries", async () => {
  const f = await fixture();
  const liveSegment = Promise.withResolvers<void>();
  const index = join(f.directory, "frames.jsonl");
  let reading = false, dirty = false, observing = true;
  const inspectIndex = async () => {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (dirty && observing) {
        dirty = false;
        const content = await readFile(index, "utf8");
        if (content.split("\n").filter(Boolean).some(line => {
          try {
            const record = JSON.parse(line);
            return record.kind === "segment" && record.file === "segment-000001.mkv" && record.status === "finalized";
          } catch { return false; } // A watcher can observe a partially appended line.
        })) liveSegment.resolve();
      }
    } catch (error) { liveSegment.reject(error); }
    finally { reading = false; }
  };
  const watcher = watch(f.directory, () => {
    // Directory events are hints, not a frames.jsonl write subscription. In
    // particular, creating the next segment follows the preceding index sync.
    // Inspect that durable state on every hint, including coalesced events that
    // arrive during a read, instead of relying on a filename-filtered edge.
    void inspectIndex();
  });
  watcher.on("error", error => liveSegment.reject(error));
  const deadline = setTimeout(() => {
    void readFile(index, "utf8").then(content => liveSegment.reject(new Error(
      `First segment did not finalize during live capture: ${JSON.stringify(f.recorder.health())}; index=${content}`)),
    error => liveSegment.reject(error));
  }, 3000);
  let manifest;
  try {
    f.emit(1, 0); f.emit(2, 33); f.emit(3, 5100); f.emit(4, 5133);
    await Promise.race([liveSegment.promise, f.incomplete.then(reason => {
      throw new Error(`Live capture failed before segment observation: ${reason}; ${JSON.stringify(f.recorder.health())}`);
    })]);
    // A real finalized segment and its index exist while capture still owns
    // the stream. An offline-only encoder cannot satisfy this observation.
    expect(f.subscribed()).toBe(true);
    expect(f.recorder.health().stored_frames).toBe(2);
    await command(["ffmpeg", "-v", "error", "-i", "segment-000001.mkv", "-f", "null", "-"], f.directory);
    manifest = await f.recorder.finish({ endedAt: 15900, reason: "interrupted" });
  } finally {
    observing = false;
    clearTimeout(deadline);
    watcher.close();
    await f.recorder.finish({ endedAt: 15900, reason: "interrupted" });
  }
  if (manifest.schema_version !== 2) throw new Error("Expected live recording manifest");
  expect(manifest.segments).toHaveLength(2);
  expect(manifest.segments.every(segment => segment.status === "finalized")).toBe(true);
  for (const segment of manifest.segments) await command(["ffmpeg", "-v", "error", "-i", segment.file, "-f", "null", "-"], f.directory);
  const probe = await timestamps(f.directory, await f.recorder.renderReplay());
  expect(probe.pts).toEqual([0, .033, 5.1, 5.133, 5.9]);
  expect(Math.abs(probe.duration - 5.9)).toBeLessThanOrEqual(.005);
}, 20000);

test("raw queue overrun is synchronous explicit and drains every already accepted frame", async () => {
  const f = await fixture({ maxPendingRawBytes: 688 });
  f.emit(1, 0); f.emit(2, 33); f.emit(3, 67);
  expect(f.subscribed()).toBe(false);
  expect(f.failures).toEqual(["pending_raw_frame_queue_bound_reached"]);
  expect(f.recorder.health()).toMatchObject({ pending_raw_bytes: 688, peak_pending_raw_bytes: 688 });
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "evidence_incomplete" });
  expect(manifest).toMatchObject({ status: "incomplete", stored_frames: 2,
    health: { pending_raw_bytes: 0, active_encoders: 0, queued_frames: 0 } });
});

test("encoded byte ceiling never leaves oversized media and joins its encoder before finish", async () => {
  const f = await fixture({ maxStoredFrameBytes: 32 });
  f.emit(1, 0);
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
  expect(manifest.status).toBe("incomplete");
  expect(manifest.failures).toContain("stored_frame_byte_bound_reached");
  expect(manifest.health).toMatchObject({ pending_raw_bytes: 0, active_encoders: 0, stored_png_bytes: 0 });
  let bytes = 0;
  for (const name of await readdir(f.directory)) if (name.endsWith(".mkv") || name.endsWith(".mp4")) bytes += (await stat(join(f.directory, name))).size;
  expect(bytes).toBeLessThanOrEqual(32);
  expect(manifest.health.stored_encoded_bytes).toBe(bytes);
});

test("finish is idempotent and interrupted capture closes the encoder with terminal evidence", async () => {
  const f = await fixture(); f.emit(1, 0);
  const finish = f.recorder.finish({ endedAt: 10123, reason: "operator_sigint" });
  expect(f.recorder.finish({ endedAt: 10999, reason: "late_call" })).toBe(finish);
  const manifest = await finish;
  expect(manifest).toMatchObject({ status: "complete", end_reason: "operator_sigint", stored_frames: 1,
    timing: { ended_at: 10123, final_hold_ms: 123 }, health: { active_encoders: 0, pending_raw_bytes: 0 } });
  const cancelled = new AbortController(); cancelled.abort(new Error("operator_cancel"));
  await expect(f.recorder.renderReplay({ signal: cancelled.signal })).rejects.toThrow("operator_cancel");
  // The cancellation did not remove the independently decodable finalized segment.
  if (manifest.schema_version !== 2) throw new Error("Expected live recording manifest");
  await command(["ffmpeg", "-v", "error", "-i", manifest.segments[0]!.file, "-f", "null", "-"], f.directory);
});

test("nonmonotonic capture is rejected before it can retime previously accepted media", async () => {
  const f = await fixture(); f.emit(2, 33); f.emit(1, 0);
  const manifest = await f.recorder.finish({ endedAt: 10200, reason: "operator_stop" });
  expect(manifest).toMatchObject({ status: "incomplete", stored_frames: 1, failures: ["nonmonotonic_native_capture_timeline"] });
});

test("live replay retains every nominal 30Hz frame instead of rounding timestamps or fixed-rate resampling", async () => {
  const f = await fixture();
  const offsets = [0, 33, 67, 100, 133, 167, 200, 233, 267, 300, 333, 367];
  for (const [index, offset] of offsets.entries()) f.emit(index + 1, offset);
  const manifest = await f.recorder.finish({ endedAt: 10400, reason: "capture_complete" });
  expect(manifest.stored_frames).toBe(12);
  expect((await timestamps(f.directory, await f.recorder.renderReplay())).pts).toEqual(
    [0, .033, .067, .1, .133, .167, .2, .233, .267, .3, .333, .367, .4]);
});

test("bottom-up native pixels decode top-down while frame index retains capture orientation", async () => {
  const f = await fixture(), pixels = new Uint8Array(16 * 16 * 4);
  // Wire bottom rows are dark, wire top rows bright. Display orientation must
  // place the bright rows first. Broad neutral bands tolerate lossy encoding.
  for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++)
    pixels.set([row < 8 ? 30 : 220, row < 8 ? 30 : 220, row < 8 ? 30 : 220, 255], (row * 16 + column) * 4);
  const packet = nativeFrame({ width: 16, height: 16, capturedAt: 10000, bottomUp: true, pixels });
  const view = new DataView(packet.buffer);
  view.setBigUint64(72, 41n, true); view.setUint32(312, 1, true); view.setFloat64(96, 12.5, true);
  f.packet(packet, 10010);
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "capture_complete" });
  const rgb = await binaryCommand(["ffmpeg", "-v", "error", "-i", await f.recorder.renderReplay(),
    "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], f.directory);
  expect(rgb.length).toBe(16 * 16 * 3);
  expect(rgb[0]).toBeGreaterThan(200); expect(rgb[15 * 16 * 3]).toBeLessThan(50);
  const record = (await readFile(join(f.directory, manifest.index), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .find(record => record.kind === "frame");
  expect(record).toMatchObject({ bottom_up: true, video_orientation: "top_down",
    capture: { life_id: 41, render: { position: { x: 12.5, y: 0, z: 0 } } } });
});

test("detached compressed replay honors sealed segment integrity without requiring a live recorder", async () => {
  const f = await fixture(); f.emit(1, 0); f.emit(2, 846);
  const manifest = await f.recorder.finish({ endedAt: 10903, reason: "capture_complete" });
  if (manifest.schema_version !== 2) throw new Error("Expected live recording manifest");
  const replay = await renderEpisodeReplay({ directory: f.directory, concatSha256: manifest.concat_sha256 });
  expect((await timestamps(f.directory, replay)).pts).toEqual([0, .846, .903]);
  const changed = await fixture(); changed.emit(1, 0);
  const sealed = await changed.recorder.finish({ endedAt: 10100, reason: "capture_complete" });
  if (sealed.schema_version !== 2) throw new Error("Expected live recording manifest");
  await writeFile(join(changed.directory, sealed.segments[0]!.file), "changed compressed payload");
  await expect(renderEpisodeReplay({ directory: changed.directory, concatSha256: sealed.concat_sha256 })).rejects.toThrow("segment changed");
  expect((await readdir(changed.directory)).includes("replay.mp4")).toBe(false);
});

test("default replay still rejects when source plus replay exceeds the sealed live capture ceiling", async () => {
  const f = await fixture({ maxStoredFrameBytes: 2048 });
  f.emit(1, 0); f.emit(2, 33); f.emit(4, 846);
  const manifest = await f.recorder.finish({ endedAt: 10903, reason: "capture_complete" });
  expect(manifest).toMatchObject({ status: "complete", stored_frames: 3, limits: { maxStoredFrameBytes: 2048 } });
  await expect(f.recorder.renderReplay()).rejects.toThrow("byte bound reached");
  let bytes = 0;
  for (const name of await readdir(f.directory)) if (name.endsWith(".mkv") || name.endsWith(".mp4"))
    bytes += (await stat(join(f.directory, name))).size;
  expect(bytes).toBeLessThanOrEqual(2048);
});

for (const captureMode of ["live_compressed", "lossless_png"] as const) {
  for (const consumer of ["recorder", "detached"] as const) {
    test(`${captureMode} ${consumer} honors a separate trusted replay ceiling without changing source limits or timing`, async () => {
      const sourceLimit = captureMode === "live_compressed" ? 2048 : 512;
      const f = await fixture({ maxStoredFrameBytes: sourceLimit }, { captureMode });
      f.emit(1, 0); f.emit(2, 33); f.emit(4, 846);
      const manifest = await f.recorder.finish({ endedAt: 10903, reason: "capture_complete" });
      expect(manifest).toMatchObject({ status: "complete", stored_frames: 3,
        limits: { maxStoredFrameBytes: sourceLimit }, timing: { capture_duration_ms: 846, final_hold_ms: 57 } });
      const sealed = await readFile(join(f.directory, "recording-manifest.json"));
      const index = await readFile(join(f.directory, manifest.index));
      const concat = await readFile(join(f.directory, manifest.concat));
      const replay = consumer === "recorder"
        ? await f.recorder.renderReplay({ combinedMaxBytes: 65536 })
        : await renderEpisodeReplay({ directory: f.directory, concatSha256: createHash("sha256").update(concat).digest("hex"),
          combinedMaxBytes: 65536 });
      const probe = await timestamps(f.directory, replay);
      expect(probe.pts).toEqual([0, .033, .846, .903]);
      expect(Math.abs(probe.duration - .903)).toBeLessThanOrEqual(.005);
      const frames = index.toString("utf8").trim().split("\n").map(line => JSON.parse(line)).filter(record => record.kind === "frame");
      expect(frames.map(record => [record.sequence, record.captured_at])).toEqual([[1, 10000], [2, 10033], [4, 10846]]);
      let sourceBytes = 0;
      for (const name of await readdir(f.directory)) if (name.endsWith(".mkv") || name.endsWith(".png"))
        sourceBytes += (await stat(join(f.directory, name))).size;
      const total = sourceBytes + (await stat(join(f.directory, replay))).size;
      expect(sourceBytes).toBeLessThanOrEqual(sourceLimit);
      expect(total).toBeGreaterThan(sourceLimit);
      expect(total).toBeLessThanOrEqual(65536);
      expect(await readFile(join(f.directory, "recording-manifest.json"))).toEqual(sealed);
      expect(await readFile(join(f.directory, manifest.index))).toEqual(index);
      expect(await readFile(join(f.directory, manifest.concat))).toEqual(concat);
    });
  }

  test(`${captureMode} rejects invalid explicit replay ceilings before creating replay output`, async () => {
    const f = await fixture({}, { captureMode });
    f.emit(1, 0);
    const manifest = await f.recorder.finish({ endedAt: 10100, reason: "capture_complete" });
    const concatSha256 = createHash("sha256").update(await readFile(join(f.directory, manifest.concat))).digest("hex");
    for (const combinedMaxBytes of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null as unknown as number]) {
      await expect(renderEpisodeReplay({ directory: f.directory, concatSha256, combinedMaxBytes })).rejects.toThrow("positive safe integer");
      expect((await readdir(f.directory)).includes("replay.mp4")).toBe(false);
    }
    // The recorder path must validate too, including live dispatch that bypasses
    // the detached wrapper. A rejected render remains single-flight.
    await expect(f.recorder.renderReplay({ combinedMaxBytes: NaN })).rejects.toThrow("positive safe integer");
    expect((await readdir(f.directory)).includes("replay.mp4")).toBe(false);
  });

  test(`${captureMode} explicit replay authorization cannot override the sealed source ceiling`, async () => {
    const f = await fixture({}, { captureMode }); f.emit(1, 0);
    const manifest = await f.recorder.finish({ endedAt: 10100, reason: "capture_complete" });
    // Deliberately inconsistent temporary disk handoff: media hashes still
    // match, but metadata claims no stored bytes and a one-byte source budget.
    // The consumer must count the actual referenced originals independently.
    manifest.limits = { ...manifest.limits, maxStoredFrameBytes: 1 };
    manifest.health.stored_encoded_bytes = 0; manifest.health.stored_png_bytes = 0;
    await writeFile(join(f.directory, "recording-manifest.json"), JSON.stringify(manifest));
    const concatSha256 = createHash("sha256").update(await readFile(join(f.directory, manifest.concat))).digest("hex");
    await expect(renderEpisodeReplay({ directory: f.directory, concatSha256, combinedMaxBytes: 65536 })).rejects.toThrow("source byte bound reached");
    expect((await readdir(f.directory)).includes("replay.mp4")).toBe(false);
  });
}

test("lossless replay without an explicit host ceiling retains its historical output behavior", async () => {
  const f = await fixture({ maxStoredFrameBytes: 512 }, { captureMode: "lossless_png" });
  f.emit(1, 0); f.emit(2, 33); f.emit(4, 846);
  const manifest = await f.recorder.finish({ endedAt: 10903, reason: "capture_complete" });
  expect(manifest.status).toBe("complete");
  const replay = await f.recorder.renderReplay();
  expect((await stat(join(f.directory, replay))).size).toBeGreaterThan(512);
  expect((await timestamps(f.directory, replay)).pts).toEqual([0, .033, .846, .903]);
});

for (const mode of ["encoder-kill", "encoder-drain-timeout", "replay-abort", "lossless-replay-abort", "replay-byte-bound", "lossless-replay-byte-bound"]) {
  test(`${mode} joins actual encoder close and closes every owned artifact handle`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-recording-lifecycle-")); roots.push(directory);
    const output = await command([process.execPath, "--no-env-file",
      join(import.meta.dir, "helpers/live-recording-lifecycle.fixture.ts"), mode, directory], directory);
    const line = output.split("\n").find(line => line.startsWith("LIVE_LIFECYCLE_RESULT "));
    if (!line) throw new Error(`Missing lifecycle evidence: ${output}`);
    const result = JSON.parse(line.slice("LIVE_LIFECYCLE_RESULT ".length));
    expect(result.children.length).toBe(mode === "replay-abort" ? 2 : mode === "replay-byte-bound" ? 4 : mode === "lossless-replay-byte-bound" ? 3 : 1);
    expect(result.children.every((child: { closed: boolean; alive: boolean }) => child.closed && !child.alive)).toBe(true);
    expect(result.handles.every((handle: { fd: number; usable: boolean }) => handle.fd === -1 && !handle.usable)).toBe(true);
    expect(result.manifest.health).toMatchObject({ active_encoders: 0, pending_raw_bytes: 0, queued_frames: 0 });
    if (mode.endsWith("replay-abort")) {
      expect(result.manifest.status).toBe("complete");
      expect(result.replayError).toContain("operator_cancelled_assembly");
    } else if (mode.endsWith("replay-byte-bound")) {
      expect(result.manifest.status).toBe("complete");
      expect(result.replayError).toContain("byte bound reached");
      expect(result.referenceBytes).toBe(result.combinedMaxBytes + 1);
      expect(result.boundaryBytes).toBe(result.referenceBytes);
      expect(result.actualBytes).toBeLessThanOrEqual(result.combinedMaxBytes);
    } else {
      expect(result.manifest.status).toBe("incomplete");
      expect(result.manifest.stored_frames).toBe(0);
    }
  });
}
