import { mock } from "bun:test";
import * as processes from "node:child_process";
import * as fs from "node:fs/promises";
import { fstatSync } from "node:fs";
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
    if (mode === "replay-abort" && children.length === 2) abort.abort(new Error("operator_cancelled_assembly"));
  });
  return child;
} }));
// Deliberate module-loading boundary: the recorder must see the subprocess-only
// resource observers above rather than cached filesystem/process bindings.
const { EpisodeRecorder } = await import("../../src/server/recording.ts");
let deliver: ((frame: Uint8Array) => void) | undefined;
const recorder = new EpisodeRecorder({ directory,
  ...(mode === "encoder-drain-timeout" ? { encoderDrainTimeoutMs: 100 } : {}),
  identity: { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" },
  bridge: { subscribeFrames(callback) { deliver = callback; return () => { deliver = undefined; }; } }, onIncomplete() {} });
const capturedAt = Date.now();
deliver!(nativeFrame({ capturedAt }));
const manifest = await recorder.finish({ endedAt: capturedAt + 100, reason: "operator_sigint" });
let replayError: string | null = null;
if (mode === "replay-abort") {
  try { await recorder.renderReplay({ signal: abort.signal }); }
  catch (error) { replayError = String(error); }
}
console.log("LIVE_LIFECYCLE_RESULT " + JSON.stringify({ manifest, replayError,
  children: children.map(({ child, closed }) => {
    let alive = false; if (child.pid) { try { process.kill(child.pid, 0); alive = true; } catch {} }
    return { pid: child.pid, closed, alive };
  }),
  handles: handles.map(file => {
    let usable = false; try { fstatSync(file.fd); usable = true; } catch {}
    return { fd: file.fd, usable };
  }),
}));
