import { mock } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { fstatSync } from "node:fs";
import * as processes from "node:child_process";
import { join } from "node:path";
import { nativeFrame } from "./native-frame.ts";

// This file runs only in a dedicated Bun subprocess. Neither PATH nor the two
// narrow resource-observation/failure seams can affect another test module.
const [mode, directory] = process.argv.slice(2);
if (!directory) throw new Error("Missing isolated fixture directory");
await fs.mkdir(directory, { recursive: true });
const handles: fs.FileHandle[] = [];
const realOpen = fs.open;
mock.module("node:fs/promises", () => ({ ...fs, open: async (...args: Parameters<typeof fs.open>) => {
  const file = await realOpen(...args);
  const name = String(args[0]);
  if (name.endsWith("frames.jsonl") || name.endsWith("-journal.jsonl")) {
    handles.push(file);
    if (mode === "journal-marker") {
      const write = file.writeFile.bind(file);
      file.writeFile = async (...input: Parameters<typeof file.writeFile>) => {
        if (String(input[0]).includes('"kind":"evidence_failure"')) throw Object.assign(new Error("Synthetic marker storage failure"), { code: "ENOSPC" });
        return await write(...input);
      };
    }
    if (mode === "journal-sync") file.sync = async () => { throw Object.assign(new Error("Synthetic journal sync failure"), { code: "EIO" }); };
  }
  return file;
} }));

async function until(read: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) { if (await read()) return; await Bun.sleep(5); }
  throw new Error(message);
}
function handleState() {
  return handles.map(file => {
    const fd = file.fd;
    let usable = false;
    try { fstatSync(fd); usable = true; } catch {}
    return { fd, usable };
  });
}
let result: Record<string, unknown>;
try {
  if (mode?.startsWith("journal-")) {
    // Intentional loading boundary: the real journal must capture the isolated
    // filesystem seam above, not a module cached before failure injection.
    const { PrivateJournal } = await import("../../src/evaluation/private-journal.ts");
    const stops: string[] = [];
    const journal = new PrivateJournal(directory, "persistence-run", (_run, why) => stops.push(why),
      mode === "journal-marker" ? { maxTextBytes: 1 } : {});
    journal.append("authorized_observation", { marker: "RETAIN_PRIOR_EVIDENCE" });
    const finalized = await journal.finalize({ status: "interrupted", reason: "operator_sigint" });
    const manifest = JSON.parse(await fs.readFile(join(directory, finalized.manifest), "utf8"));
    result = { finalized, manifest, stops, handles: handleState(),
      journal: await fs.readFile(join(directory, finalized.journal), "utf8") };
  } else {
    let child: processes.ChildProcess | undefined, childClosed = false;
    const actualSpawn = processes.spawn;
    mock.module("node:child_process", () => ({ ...processes, spawn: (...args: Parameters<typeof processes.spawn>) => {
      child = actualSpawn(...args);
      child.once("close", () => { childClosed = true; });
      return child;
    } }));
    // Intentional loading boundary: observe real owned spawn/handles only after
    // installing the subprocess-local seams; capture/encoding remain real.
    const recording = await import("../../src/server/recording.ts");
    const { EpisodeRecorder } = recording;
    let deliver: ((frame: Uint8Array) => void) | undefined;
    const failures: string[] = [];
    const recorder = new EpisodeRecorder({ directory, captureMode: "lossless_png",
      bridge: { subscribeFrames(callback) { deliver = callback; return () => { deliver = undefined; }; } },
      identity: { episode_id: "episode", run_id: "run", world_id: "world", session_id: "session" },
      onIncomplete: why => failures.push(why) });
    const capturedAt = Date.now();
    deliver!(nativeFrame({ capturedAt }));
    if (mode === "concat-failure") await fs.mkdir(join(directory, "replay.ffconcat"));
    let finishError: { code?: string; message: string } | null = null;
    let manifest: unknown = null;
    try { manifest = await recorder.finish({ endedAt: capturedAt + 100, reason: "operator_sigint" }); }
    catch (error) { const failure = error as NodeJS.ErrnoException; finishError = { code: failure.code, message: failure.message }; }
    if (mode === "concat-failure") {
      let durableManifest: unknown = null;
      try { durableManifest = JSON.parse(await fs.readFile(join(directory, "recording-manifest.json"), "utf8")); } catch {}
      result = { manifest, durableManifest, finishError, failures, handles: handleState(),
        index: await fs.readFile(join(directory, "frames.jsonl"), "utf8"),
        png: [...(await fs.readFile(join(directory, "frame-000001.png"))).subarray(0, 8)] };
    } else if (mode === "detached-replaced-concat") {
      if (finishError) throw new Error(`Unexpected capture failure: ${finishError.message}`);
      const concatSha256 = createHash("sha256").update(await fs.readFile(join(directory, "replay.ffconcat"))).digest("hex");
      await fs.writeFile(join(directory, "replay.ffconcat"),
        `ffconcat version 1.0\nfile '${join(directory, "frame-000001.png")}'\nduration 0.1\n`);
      let error: string | null = null;
      try { await recording.renderEpisodeReplay({ directory, concatSha256, timeoutMs: 1500 }); }
      catch (failure) { error = String(failure); }
      let replayExists = false;
      try { await fs.access(join(directory, "replay.mp4")); replayExists = true; } catch {}
      result = { error, spawned: child !== undefined, replayExists, manifest };
    } else {
      if (finishError) throw new Error(`Unexpected capture failure: ${finishError.message}`);
      const bin = join(directory, "bin"); await fs.mkdir(bin);
      // Real owned child, not an FFmpeg dependency. It deliberately never exits
      // until its owner cancels it; the pid marker proves execution began.
      await fs.writeFile(join(bin, "ffmpeg"), `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync("renderer.pid", String(process.pid));\nsetInterval(() => { if (process.ppid !== ${process.pid}) process.exit(1); }, 50);\n`, { mode: 0o700 });
      process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
      const abort = new AbortController();
      let settled: { status: string; closed: boolean; error: string | null } | null = null;
      const rendering = recorder.renderReplay({ signal: abort.signal, timeoutMs: mode === "render-timeout" ? 500 : 1500 }).then(
        () => { settled = { status: "fulfilled", closed: childClosed, error: null }; },
        error => { settled = { status: "rejected", closed: childClosed, error: String(error) }; });
      try {
        await until(async () => { try { await fs.access(join(directory, "renderer.pid")); return true; } catch { return false; } }, "Synthetic renderer never started");
        if (mode === "render-abort") abort.abort(new Error("operator_sigint"));
        await Promise.race([rendering, Bun.sleep(2000)]);
        const observed = settled as { status: string; closed: boolean; error: string | null } | null;
        const pid = Number(await fs.readFile(join(directory, "renderer.pid"), "utf8"));
        let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
        result = { settled: observed, alive, manifest,
          index: await fs.readFile(join(directory, "frames.jsonl"), "utf8"),
          png: [...(await fs.readFile(join(directory, "frame-000001.png"))).subarray(0, 8)],
          concat: await fs.readFile(join(directory, "replay.ffconcat"), "utf8") };
      } finally {
        if (child && !childClosed) child.kill("SIGKILL");
        await rendering;
      }
    }
  }
  console.log(`LIFECYCLE_RESULT ${JSON.stringify(result)}`);
} finally {
  // The reported states above precede this fixture-owned leak containment.
  for (const file of handles) if (file.fd >= 0) await file.close();
}
