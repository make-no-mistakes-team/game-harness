import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { encodeNativeFramePng } from "../src/server/actor-frame-codec.ts";
import { decodeRgbaPng, nativeFrame } from "./helpers/native-frame.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const identity = { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" };
async function fixture(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-recording-")); roots.push(directory);
  let listener: ((frame: Uint8Array) => void) | null = null, monotonic = 0;
  const incomplete: string[] = [];
  const bridge = { subscribeFrames(callback: (frame: Uint8Array) => void) { listener = callback; return () => { listener = null; }; } };
  const recorder = new EpisodeRecorder({ directory, bridge, identity, captureMode: "lossless_png", now: () => 10000 + monotonic,
    monotonicNow: () => monotonic, onIncomplete: (reason: string) => incomplete.push(reason), ...options });
  return { recorder, directory, incomplete, subscribed: () => listener !== null,
    emit(sequence: number, capturedAt: number, receivedAt = capturedAt + 10, frame = nativeFrame({ sequence, capturedAt })) {
      monotonic = receivedAt - 10000;
      listener?.(frame);
    } };
}
async function index(directory: string, name: string) {
  return (await readFile(join(directory, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("explicit lossless recorder writes every delivered PNG and nonuniform capture timeline including final hold", async () => {
  const f = await fixture();
  f.emit(10, 10000); f.emit(11, 10050); f.emit(13, 10500);
  const manifest = await f.recorder.finish({ endedAt: 11200, reason: "operator_stop" });
  expect(f.subscribed()).toBe(false);
  expect(manifest).toMatchObject({ status: "complete", audio: "not_recorded", delivered_frames: 3, stored_frames: 3, end_reason: "operator_stop" });
  const records = await index(f.directory, manifest.index);
  const frames = records.filter(record => record.kind === "frame");
  expect(frames.map(frame => frame.sequence)).toEqual([10, 11, 13]);
  expect(frames.map(frame => frame.captured_at)).toEqual([10000, 10050, 10500]);
  expect(frames.map(frame => frame.received_monotonic_ms)).toEqual([10, 60, 510]);
  expect(frames.every(frame => frame.width === 2 && frame.height === 2 && frame.bottom_up === false)).toBe(true);
  expect(frames.every(frame => Object.entries(identity).every(([key, value]) => frame[key] === value))).toBe(true);
  expect(records).toContainEqual(expect.objectContaining({ kind: "upstream_gap", previous_sequence: 11, sequence: 13,
    missing_sequences: 1, capture_delta_ms: 450 }));
  for (const frame of frames) expect(decodeRgbaPng(await readFile(join(f.directory, frame.file))).width).toBe(2);
  const concat = await readFile(join(f.directory, manifest.concat), "utf8");
  expect(concat.split("\n").filter(line => line.startsWith("duration ")).map(line => Number(line.slice(9)))).toEqual([0.05, 0.45, 0.7]);
  const files = concat.split("\n").filter(line => line.startsWith("file "));
  expect(files).toHaveLength(4); // Repeat final PNG after its explicit hold for ffconcat.
  expect(files.at(-1)).toBe(files.at(-2));
  expect(manifest.limitations.join(" ")).toMatch(/upstream|producer/i);
});

test("invalid recording limits reject before subscribing or allocating artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-invalid-recording-")); roots.push(root);
  for (const [ordinal, limits] of [
    { maxFrames: 0 }, { maxFrames: -1 }, { maxFrames: 1.5 }, { maxFrames: Number.NaN },
    { maxDurationMs: Infinity }, { maxStoredFrameBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxPendingRawBytes: 512 * 1024 ** 2 + 1 }, { unexpected: 1 },
  ].entries()) {
    let subscriptions = 0;
    const directory = join(root, String(ordinal));
    let recorder: EpisodeRecorder | undefined;
    try {
      expect(() => {
        recorder = new EpisodeRecorder({ directory, identity, onIncomplete() {}, limits,
          bridge: { subscribeFrames() { subscriptions++; return () => {}; } } });
      }).toThrow();
      expect(subscriptions).toBe(0);
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (recorder) await recorder.finish({ endedAt: Date.now(), reason: "test_cleanup" });
    }
  }
});

test("health reports accepted raw backlog and peaks while two real PNG encodes are blocked", async () => {
  const gate = Promise.withResolvers<void>(), bothEntered = Promise.withResolvers<void>();
  let entered = 0;
  const limits = { maxFrames: 3, maxPendingRawBytes: 1032, maxStoredFrameBytes: 4096, maxDurationMs: 5000 };
  const f = await fixture({ limits, encode: async (frame: Uint8Array, receivedAt: number) => {
    if (++entered === 2) bothEntered.resolve();
    await gate.promise;
    return await encodeNativeFramePng(frame, receivedAt);
  } });
  for (let sequence = 1; sequence <= 3; sequence++) f.emit(sequence, 10000 + (sequence - 1) * 50);
  await bothEntered.promise;
  let finished = false;
  try {
    expect(f.recorder.health()).toMatchObject({ accepting: true, delivered_frames: 3, stored_frames: 0,
      pending_raw_bytes: 1032, peak_pending_raw_bytes: 1032, active_encoders: 2, queued_frames: 1, stored_png_bytes: 0, failures: [] });
    const snapshot = f.recorder.health();
    snapshot.failures.push("caller_mutation");
    expect(f.recorder.health().failures).toEqual([]);
    const finish = f.recorder.finish({ endedAt: 10800, reason: "operator_stop" })
      .then(value => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve();
    const manifest = await finish;
    const pngNames = (await readdir(f.directory)).filter(name => name.endsWith(".png"));
    let actualBytes = 0;
    for (const name of pngNames) actualBytes += (await stat(join(f.directory, name))).size;
    expect(actualBytes).toBeGreaterThan(0);
    expect(manifest).toMatchObject({ schema_version: 1, limits,
      timing: { first_capture_at: 10000, last_capture_at: 10100, ended_at: 10800,
        capture_duration_ms: 100, final_hold_ms: 700 },
      health: { accepting: false, delivered_frames: 3, stored_frames: 3, pending_raw_bytes: 0,
        peak_pending_raw_bytes: 1032, active_encoders: 0, queued_frames: 0, stored_png_bytes: actualBytes, failures: [] } });
    expect(f.recorder.health()).toEqual(manifest.health);
    expect(JSON.parse(await readFile(join(f.directory, "recording-manifest.json"), "utf8"))).toEqual(manifest);
  } finally {
    gate.resolve();
    await f.recorder.finish({ endedAt: 10800, reason: "operator_stop" });
  }
});

test("stored PNG bytes count only successful durable files when artifact creation fails", async () => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture({ encode: async (frame: Uint8Array, receivedAt: number) => {
    await gate.promise;
    return await encodeNativeFramePng(frame, receivedAt);
  } });
  // A pre-existing artifact makes the exclusive durable creation fail.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(f.directory, "frame-000001.png"), "collision", { flag: "wx" });
  f.emit(1, 10000);
  gate.resolve();
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
  expect(manifest).toMatchObject({ status: "incomplete", stored_frames: 0,
    health: { stored_png_bytes: 0, pending_raw_bytes: 0, active_encoders: 0 },
    timing: { first_capture_at: null, last_capture_at: null, ended_at: 10100,
      capture_duration_ms: null, final_hold_ms: null } });
  expect(manifest.failures).toContain("frame_encoder_or_persistence_failed");
});

test("exact frame and stored byte limits admit the boundary before recording the first overrun", async () => {
  const frame = nativeFrame({ sequence: 1, capturedAt: 10000 });
  const pngBytes = (await encodeNativeFramePng(frame, 10010)).png.length;
  for (const limits of [{ maxFrames: 1 }, { maxStoredFrameBytes: pngBytes }]) {
    const f = await fixture({ limits });
    f.emit(1, 10000, 10010, frame);
    f.emit(2, 10010);
    const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
    expect(manifest).toMatchObject({ status: "incomplete", delivered_frames: 2, stored_frames: 1,
      health: { pending_raw_bytes: 0, stored_png_bytes: pngBytes } });
    expect(manifest.failures).toContain("maxFrames" in limits
      ? "delivered_frame_count_bound_reached" : "stored_frame_byte_bound_reached");
  }
});

test("capture duration admits the exact receipt boundary and rejects the next millisecond explicitly", async () => {
  const f = await fixture({ limits: { maxDurationMs: 50 } });
  f.emit(1, 10000, 10050);
  f.emit(2, 10001, 10051);
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
  expect(manifest).toMatchObject({ status: "incomplete", delivered_frames: 2, stored_frames: 1,
    health: { pending_raw_bytes: 0 } });
  expect(manifest.failures).toContain("episode_duration_bound_reached");
  expect((await index(f.directory, manifest.index)).filter(record => record.kind === "frame")).toHaveLength(1);
});

test("interruption drains accepted encodes before durable finalization without rendering replay", async () => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture({ encode: async (frame: Uint8Array, receivedAt: number) => {
    await gate.promise; return await encodeNativeFramePng(frame, receivedAt);
  } });
  f.emit(1, 10000);
  let finished = false;
  const finish = f.recorder.finish({ endedAt: 11000, reason: "interrupted" }).then(value => { finished = true; return value; });
  await Promise.resolve(); expect(finished).toBe(false);
  gate.resolve();
  const manifest = await finish;
  expect(manifest.stored_frames).toBe(1);
  expect(manifest.end_reason).toBe("interrupted");
  expect((await index(f.directory, manifest.index)).filter(record => record.kind === "frame")).toHaveLength(1);
  expect((await readdir(f.directory)).some(name => name.endsWith(".mp4"))).toBe(false);
});

test("recorder retains exact packet capture diagnostics without synchronizing actor observations", async () => {
  const f = await fixture(), packet = nativeFrame({ capturedAt: 10000 });
  const view = new DataView(packet.buffer);
  view.setBigInt64(32, 9007199254740993n, true);
  view.setBigInt64(40, 9007199254740999n, true);
  view.setBigInt64(48, 9007199254740991n, true);
  view.setBigUint64(72, 41n, true);
  view.setFloat64(96, 12.5, true);
  view.setFloat32(132, 1, true);
  view.setUint32(312, 1, true);
  f.emit(1, 10000, 10010, packet);
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
  const records = await index(f.directory, manifest.index);
  expect(records.find(record => record.kind === "frame")).toMatchObject({
    captured_at: 10000, png_orientation: "top_down",
    capture: { schema_version: 1, readback_started_ns: "9007199254740993",
      readback_finished_ns: "9007199254740999", life_id: 41,
      render: { sampled_ns: "9007199254740991", position: { x: 12.5, y: 0, z: 0 } } },
  });
});

test("finish drains a later delivery burst after the first burst has already persisted", async () => {
  const laterEntered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture({ encode: async (frame: Uint8Array, receivedAt: number) => {
    if (new DataView(frame.buffer, frame.byteOffset).getUint32(16, true) === 2) {
      laterEntered.resolve(); await release.promise;
    }
    return await encodeNativeFramePng(frame, receivedAt);
  } });
  f.emit(1, 10000);
  // Index admission follows PNG fsync; observing its real record also lets the
  // first encode's completion microtasks settle before the second burst.
  const first = join(f.directory, "frame-000001.png");
  let persisted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      persisted = (await readFile(join(f.directory, "frames.jsonl"), "utf8")).includes('"kind":"frame"');
      if (persisted) break;
    }
    catch { await Bun.sleep(5); }
    if (!persisted) await Bun.sleep(5);
  }
  expect(persisted).toBe(true);
  expect(decodeRgbaPng(await readFile(first)).width).toBe(2);
  f.emit(2, 10100); await laterEntered.promise;
  let settled = false;
  const finish = f.recorder.finish({ endedAt: 10200, reason: "interrupted" }).then(value => { settled = true; return value; });
  await Promise.resolve(); expect(settled).toBe(false);
  release.resolve();
  expect((await finish).stored_frames).toBe(2);
});

test("queue overflow returns from delivery synchronously and fails the attempt visibly without silent drops", async () => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture({ limits: { maxPendingRawBytes: 344 }, encode: async (frame: Uint8Array, receivedAt: number) => {
    await gate.promise; return await encodeNativeFramePng(frame, receivedAt);
  } });
  // Each 2x2 packet owns 344 bytes including its header; accepting the next would exceed the queue bound.
  f.emit(1, 10000); f.emit(2, 10010);
  expect(f.incomplete.length).toBe(1);
  expect(f.incomplete[0]).toMatch(/queue|pending/i);
  expect(f.subscribed()).toBe(false);
  gate.resolve();
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "evidence_incomplete" });
  expect(manifest).toMatchObject({ status: "incomplete", delivered_frames: 2, stored_frames: 1 });
  expect((await index(f.directory, manifest.index)).some(record => record.kind === "failure")).toBe(true);
});

test("at most two asynchronous encodes run and all accepted frames survive drain", async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0, peak = 0;
  const f = await fixture({ encode: async (frame: Uint8Array, receivedAt: number) => {
    active++; peak = Math.max(peak, active);
    await gate.promise;
    try { return await encodeNativeFramePng(frame, receivedAt); } finally { active--; }
  } });
  for (let sequence = 1; sequence <= 5; sequence++) f.emit(sequence, 10000 + sequence);
  await Promise.resolve();
  expect(peak).toBeLessThanOrEqual(2);
  gate.resolve();
  const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2); expect(manifest.stored_frames).toBe(5);
});

test("encoder failure retains prior files and an explicit incomplete index", async () => {
  const f = await fixture({ encode: async (frame: Uint8Array, receivedAt: number) => {
    if (new DataView(frame.buffer, frame.byteOffset).getUint32(16, true) === 2) throw new Error("Synthetic encoder failure");
    return await encodeNativeFramePng(frame, receivedAt);
  } });
  f.emit(1, 10000); f.emit(2, 10010);
  const manifest = await f.recorder.finish({ endedAt: 10200, reason: "operator_stop" });
  expect(manifest.status).toBe("incomplete"); expect(f.incomplete).toHaveLength(1);
  const records = await index(f.directory, manifest.index);
  expect(records.filter(record => record.kind === "frame")).toHaveLength(1);
  expect(records.some(record => record.kind === "failure")).toBe(true);
});

test("frame, stored-byte and episode-duration limits stop capture with retained incomplete evidence", async () => {
  for (const limits of [{ maxFrames: 1 }, { maxStoredFrameBytes: 1 }, { maxDurationMs: 50 }]) {
    const f = await fixture({ limits });
    f.emit(1, 10000); f.emit(2, 10100);
    const manifest = await f.recorder.finish({ endedAt: 10200, reason: "operator_stop" });
    expect(manifest.status).toBe("incomplete");
    expect(f.incomplete).toHaveLength(1);
    expect((await index(f.directory, manifest.index)).some(record => record.kind === "failure")).toBe(true);
  }
});

test("dimension or orientation changes never reinterpret previously delivered pixels", async () => {
  for (const next of [nativeFrame({ width: 1, height: 4, capturedAt: 10010, sequence: 2 }),
    nativeFrame({ bottomUp: true, capturedAt: 10010, sequence: 2 })]) {
    const f = await fixture(); f.emit(1, 10000); f.emit(2, 10010, 10020, next);
    const manifest = await f.recorder.finish({ endedAt: 10100, reason: "operator_stop" });
    const records = await index(f.directory, manifest.index);
    // Both allowed implementations are honest: explicit segmentation, or retained prior evidence + closed failure.
    expect(manifest.status === "incomplete" || records.some(record => record.kind === "segment" && record.sequence === 2)).toBe(true);
    expect(records.some(record => record.kind === "frame" && record.sequence === 1)).toBe(true);
  }
});

async function lifecycle(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-recording-lifecycle-")); roots.push(directory);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/recording-lifecycle.fixture.ts"), mode, directory], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GAMEHARNESS_DATA_DIR: join(directory, "data") },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exit !== 0) throw new Error(`Isolated ${mode} fixture failed (${exit}): ${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(value => value.startsWith("LIFECYCLE_RESULT "));
    if (!line) throw new Error(`Isolated ${mode} fixture returned no resource evidence: ${stderr}\n${stdout}`);
    return JSON.parse(line.slice("LIFECYCLE_RESULT ".length));
  } finally { clearTimeout(deadline); }
}

for (const mode of ["render-abort", "render-timeout"]) {
  test(`${mode}: replay rejection joins the actual encoder child and retains the captured episode`, async () => {
    const result = await lifecycle(mode);
    // Killing a mock, or racing a deadline while the owned child remains alive,
    // cannot satisfy these actual process/close-event and persisted-file facts.
    expect(result.settled).toMatchObject({ status: "rejected", closed: true });
    expect(result.alive).toBe(false);
    expect(result.manifest).toMatchObject({ status: "complete", stored_frames: 1 });
    expect(result.png).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const records = result.index.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(records.filter((record: { kind: string }) => record.kind === "frame")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ kind: "end", reason: "operator_sigint" });
    expect(result.concat).toContain("duration 0.1");
  }, 10000);
}

test("concat persistence failure closes the real index handle without declaring clean evidence", async () => {
  const result = await lifecycle("concat-failure");
  expect(result.handles).toEqual([{ fd: -1, usable: false }]);
  expect(result.png).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(result.index).toContain('"kind":"frame"');
  // Either propagate the original storage error, or retain an explicit
  // incomplete manifest. A fabricated clean manifest is never acceptable.
  if (result.finishError) {
    expect(["EEXIST", "EISDIR"]).toContain(result.finishError.code);
    expect(result.finishError.message).toContain("replay.ffconcat");
  } else {
    expect(result.manifest).toMatchObject({ status: "incomplete" });
    expect(result.manifest.failures.length).toBeGreaterThan(0);
  }
  expect(result.durableManifest?.status).not.toBe("complete");
}, 10000);
