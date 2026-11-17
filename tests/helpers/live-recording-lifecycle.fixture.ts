import { mock } from "bun:test";
import * as processes from "node:child_process";
import * as fs from "node:fs/promises";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { nativeFrame } from "./native-frame.ts";

// Process-local observation only: every encoder/remuxer remains the actual
// FFmpeg binary. Signals exercise its real close barrier, not a fake hook.
const [mode, directory] = process.argv.slice(2);
if (!directory) throw new Error("Missing fixture directory");
const abort = new AbortController();
const children: Array<{ child: processes.ChildProcess; closed: boolean }> = [];
const handles: fs.FileHandle[] = [];
const realOpen = fs.open, realSpawn = processes.spawn;
mock.module("node:fs/promises", () => ({ ...fs, open: async (...args: Parameters<typeof fs.open>) => {
  const file = await realOpen(...args); handles.push(file); return file;
} }));
mock.module("node:child_process", () => ({ ...processes, spawn: (...args: Parameters<typeof processes.spawn>) => {
  const child = realSpawn(...args), owner = { child, closed: false };
  children.push(owner);
  child.once("close", () => { owner.closed = true; });
  child.once("spawn", () => {
    if (mode === "encoder-kill" && children.length === 1) child.kill("SIGKILL");
    if (mode === "encoder-drain-timeout" && children.length === 1) child.kill("SIGSTOP");
    if ((mode === "replay-abort" && children.length === 2) || mode === "lossless-replay-abort")
      abort.abort(new Error("operator_cancelled_assembly"));
  });
  return child;
} }));
// Deliberate module-loading boundary: the recorder must see the subprocess-only
// resource observers above rather than cached filesystem/process bindings.
const { EpisodeRecorder, renderEpisodeReplay } = await import("../../src/server/recording.ts");
let deliver: ((frame: Uint8Array) => void) | undefined;
const recorder = new EpisodeRecorder({ directory,
  ...(mode?.startsWith("lossless-") ? { captureMode: "lossless_png" as const } : {}),
  ...(mode === "encoder-drain-timeout" ? { encoderDrainTimeoutMs: 100 } : {}),
  identity: { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" },
  bridge: { subscribeFrames(callback) { deliver = callback; return () => { deliver = undefined; }; } }, onIncomplete() {} });
const capturedAt = Date.now();
deliver!(nativeFrame({ capturedAt }));
const manifest = await recorder.finish({ endedAt: capturedAt + 100, reason: "operator_sigint" });
let replayError: string | null = null;
let combinedMaxBytes: number | undefined, referenceBytes: number | undefined, actualBytes: number | undefined, boundaryBytes: number | undefined;
if (mode?.endsWith("replay-byte-bound")) {
  const reference = join(directory, "reference");
  await fs.mkdir(reference);
  const names = (await fs.readdir(directory)).filter(name => name !== "reference");
  for (const name of names)
    await fs.copyFile(join(directory, name), join(reference, name));
  const { createHash } = await import("node:crypto");
  const concatSha256 = createHash("sha256").update(await fs.readFile(join(reference, manifest.concat))).digest("hex");
  await renderEpisodeReplay({ directory: reference, concatSha256, combinedMaxBytes: 65536 });
  let sourceBytes = 0;
  for (const name of await fs.readdir(directory)) if (name.endsWith(".mkv") || name.endsWith(".png"))
    sourceBytes += (await fs.stat(join(directory, name))).size;
  referenceBytes = sourceBytes + (await fs.stat(join(reference, "replay.mp4"))).size;
  const boundary = join(directory, "boundary");
  await fs.mkdir(boundary);
  for (const name of names) await fs.copyFile(join(directory, name), join(boundary, name));
  await renderEpisodeReplay({ directory: boundary, concatSha256, combinedMaxBytes: referenceBytes });
  boundaryBytes = sourceBytes + (await fs.stat(join(boundary, "replay.mp4"))).size;
  combinedMaxBytes = referenceBytes - 1;
  try { await recorder.renderReplay({ combinedMaxBytes }); }
  catch (error) { replayError = String(error); }
  actualBytes = sourceBytes + (await fs.stat(join(directory, "replay.mp4"))).size;
}
if (mode?.endsWith("replay-abort")) {
  try { await recorder.renderReplay({ signal: abort.signal, combinedMaxBytes: 65536 }); }
  catch (error) { replayError = String(error); }
}
console.log("LIVE_LIFECYCLE_RESULT " + JSON.stringify({ manifest, replayError, combinedMaxBytes, referenceBytes, actualBytes, boundaryBytes,
  children: children.map(({ child, closed }) => {
    let alive = false; if (child.pid) { try { process.kill(child.pid, 0); alive = true; } catch {} }
    return { pid: child.pid, closed, alive };
  }),
  handles: handles.map(file => {
    let usable = false; try { fstatSync(file.fd); usable = true; } catch {}
    return { fd: file.fd, usable };
  }),
}));
