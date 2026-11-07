import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as recording from "../src/server/recording.ts";
import { nativeFrame } from "./helpers/native-frame.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

interface ReplayProbe {
  frames: { best_effort_timestamp_time: string }[];
  streams: { nb_frames: string }[];
  format: { duration: string };
}
async function probeReplay(directory: string, replay: string): Promise<ReplayProbe> {
  const child = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_streams", "-show_format",
    "-show_entries", "frame=best_effort_timestamp_time:stream=nb_frames:format=duration", "-of", "json", replay], {
      cwd: directory, stdout: "pipe", stderr: "pipe" });
  // Observe actual process exit; this timer only contains a deadlock.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`Actual FFprobe failed (${exit}): ${stderr}`);
    return JSON.parse(stdout);
  } finally { clearTimeout(timeout); await child.exited; }
}
async function recordedReplay(offsets: readonly number[], endedOffset: number, varyingPixels: boolean,
  beforeRender?: (directory: string) => Promise<void>): Promise<ReplayProbe> {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-replay-timing-")); roots.push(directory);
  let listener: ((frame: Uint8Array) => void) | undefined, now = 10000;
  const recorder = new recording.EpisodeRecorder({ directory, captureMode: "lossless_png", identity: { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" },
    bridge: { subscribeFrames(callback) { listener = callback; return () => { listener = undefined; }; } },
    now: () => now, monotonicNow: () => now - 10000, onIncomplete: reason => { throw new Error(reason); } });
  try {
    for (const [index, offset] of offsets.entries()) {
      now = 10000 + offset + 5;
      const pixels = new Uint8Array(16);
      for (let pixel = 0; pixel < 4; pixel++) {
        pixels[pixel * 4] = varyingPixels ? (index * 17) % 256 : 40;
        pixels[pixel * 4 + 1] = 60; pixels[pixel * 4 + 2] = 80; pixels[pixel * 4 + 3] = 255;
      }
      listener!(nativeFrame({ sequence: index + 1, capturedAt: 10000 + offset, pixels }));
    }
    await recorder.finish({ endedAt: 10000 + endedOffset, reason: "controlled_capture_completed" });
    await beforeRender?.(directory);
    const replay = await recorder.renderReplay({ timeoutMs: 3000 });
    return await probeReplay(directory, replay);
  } finally { await recorder.finish({ endedAt: 10000 + endedOffset, reason: "test_cleanup" }); }
}

async function finalizedCapture(offsets: readonly number[], endedOffset: number) {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-detached-replay-")); roots.push(directory);
  let listener: ((frame: Uint8Array) => void) | undefined, now = 10000;
  const recorder = new recording.EpisodeRecorder({ directory, captureMode: "lossless_png",
    identity: { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" },
    bridge: { subscribeFrames(callback) { listener = callback; return () => { listener = undefined; }; } },
    now: () => now, monotonicNow: () => now - 10000, onIncomplete: reason => { throw new Error(reason); } });
  try {
    for (const [index, offset] of offsets.entries()) {
      now = 10000 + offset + 5;
      const pixels = new Uint8Array(16);
      for (let pixel = 0; pixel < 4; pixel++) pixels.set([(index * 17) % 256, 60, 80, 255], pixel * 4);
      listener!(nativeFrame({ sequence: index + 1, capturedAt: 10000 + offset, pixels }));
    }
    const manifest = await recorder.finish({ endedAt: 10000 + endedOffset, reason: "controlled_capture_completed" });
    expect(manifest.status).toBe("complete");
    expect(listener).toBeUndefined();
    return { directory, concatSha256: createHash("sha256").update(await readFile(join(directory, manifest.concat))).digest("hex") };
  } finally { await recorder.finish({ endedAt: 10000 + endedOffset, reason: "test_cleanup" }); }
}

test("real replay preserves every 30Hz image and its native millisecond presentation timestamp", async () => {
  const probe = await recordedReplay([0, 33, 67, 100, 133, 167, 200, 233, 267, 300, 333, 367], 400, true);
  // Twelve actual delivered images plus the explicit final hold boundary image.
  expect(Number(probe.streams[0]!.nb_frames)).toBe(13);
  expect(probe.frames.map(frame => Number(frame.best_effort_timestamp_time))).toEqual(
    [0, .033, .067, .1, .133, .167, .2, .233, .267, .3, .333, .367, .4]);
  expect(Math.abs(Number(probe.format.duration) - .4)).toBeLessThanOrEqual(.005);
});

test("real replay retains a large terminal capture gap and final hold in the playable MP4 duration", async () => {
  const probe = await recordedReplay([0, 33, 67, 100, 133, 167, 200, 846], 903, false);
  expect(Math.abs(Number(probe.format.duration) - .903)).toBeLessThanOrEqual(.005);
  expect(probe.frames.map(frame => Number(frame.best_effort_timestamp_time))).toEqual([0, .033, .067, .1, .133, .167, .2, .846, .903]);
  expect(Number(probe.streams[0]!.nb_frames)).toBe(9);
});

test("replay never consumes a concat manifest replaced after capture finalization", async () => {
  await expect(recordedReplay([0], 100, false, async directory => {
    const absolute = join(directory, "frame-000001.png");
    await writeFile(join(directory, "replay.ffconcat"),
      `ffconcat version 1.0\nfile '${absolute}'\nduration 0.1\nfile '${absolute}'\n`);
  })).rejects.toThrow();
});

test("detached replay retains every finalized image at native millisecond timestamps and the terminal hold", async () => {
  // The fixture returns only a sealed disk handoff: no recorder or bridge owner
  // survives into the detached consumer.
  const capture = await finalizedCapture([0, 33, 67, 100, 133, 167, 200, 233, 267, 300, 333, 846], 903);
  const replay = await recording.renderEpisodeReplay({ ...capture, timeoutMs: 3000 });
  expect(replay).toBe("replay.mp4");
  const probe = await probeReplay(capture.directory, replay);
  expect(Number(probe.streams[0]!.nb_frames)).toBe(13);
  expect(probe.frames.map(frame => Number(frame.best_effort_timestamp_time))).toEqual(
    [0, .033, .067, .1, .133, .167, .2, .233, .267, .3, .333, .846, .903]);
  expect(Math.abs(Number(probe.format.duration) - .903)).toBeLessThanOrEqual(.005);
});

test("detached replay rejects a replaced concat against its old sealed digest before spawning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-detached-integrity-")); roots.push(directory);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/recording-lifecycle.fixture.ts"), "detached-replaced-concat", directory],
  { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`Actual recording lifecycle fixture failed (${exit}): ${stderr}`);
    const line = stdout.split("\n").find(line => line.startsWith("LIFECYCLE_RESULT "));
    if (!line) throw new Error(`Missing recording lifecycle result: ${stdout}`);
    const result = JSON.parse(line.slice("LIFECYCLE_RESULT ".length));
    expect(result.error).toContain("concat changed after finalization");
    expect(result.spawned).toBe(false);
    expect(result.replayExists).toBe(false);
    expect(result.manifest.status).toBe("complete");
  } finally { clearTimeout(timeout); await child.exited; }
});

test("detached replay requires an exact lowercase SHA256 digest", async () => {
  const capture = await finalizedCapture([0], 100);
  for (const concatSha256 of ["", "g".repeat(64), capture.concatSha256.toUpperCase(), `${capture.concatSha256}\n`]) {
    await expect(recording.renderEpisodeReplay({ ...capture, concatSha256, timeoutMs: 3000 })).rejects.toThrow(/digest|sha256/i);
  }
  // Rejections must leave the original capture available for a valid consumer.
  expect(await recording.renderEpisodeReplay({ ...capture, timeoutMs: 3000 })).toBe("replay.mp4");
});
