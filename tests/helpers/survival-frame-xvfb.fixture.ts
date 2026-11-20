import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openTrustedFrameCapture } from "../../src/server/survival-macro/compose.ts";
import type { MacroObservation } from "../../src/server/survival-macro/protocol.ts";

const dir = process.cwd();
const [xvfb, xsetroot, ffmpeg] = process.argv.slice(2) as [string, string, string];
const display = process.env.DISPLAY;
const authority = process.env.XAUTHORITY;
assert(display && /^:\d+$/.test(display));
assert.equal(authority, path.join(dir, "Xauthority"));
const lock = `/tmp/.X${display.slice(1)}-lock`;
const pid = readFileSync(lock, "utf8").trim();
assert.match(pid, /^[1-9]\d*$/);
const proc = `/proc/${pid}`;
const identity = () => readFileSync(`${proc}/stat`, "utf8").split(") ")[1]!.split(" ");
const born = identity()[19];
const assertDisplay = () => {
  const current = identity();
  assert.equal(readFileSync(lock, "utf8").trim(), pid);
  assert.equal(realpathSync(`${proc}/exe`), realpathSync(xvfb));
  assert.equal(Number(current[1]), process.ppid);
  assert.equal(current[19], born);
  assert.equal(statSync(authority).mode & 0o077, 0);
};
assertDisplay();
const color = "#35a96e";
assert.equal(Bun.spawnSync([xsetroot, "-display", display, "-solid", color], { stderr: "pipe" }).exitCode, 0);

const observation = {
  v: 1, run: path.basename(dir), life: 1, epoch: 5, tick: 10, goal: "stone_pickaxe", health: 20, food: 20,
  inventory: {}, opportunities: [], recent: [], quiescent: false,
} satisfies MacroObservation;
await mkdir(path.join(dir, "macro"), { mode: 0o700 });
await writeFile(path.join(dir, "macro", "observation.json"), JSON.stringify(observation), { mode: 0o600 });
const signal = new AbortController().signal;
const settings = {
  dir, display: { display, authority, stillOwned: () => { assertDisplay(); return true; } }, width: 1280, height: 720,
  ffmpeg: path.join(dir, "not-an-ffmpeg-binary"), signal, assertDisplay,
};
const capture = await openTrustedFrameCapture(settings);
const frame = await capture(observation, signal, "stable-1");
assert("data" in frame, JSON.stringify(frame));
assert.equal(frame.tick, observation.tick);
assert(frame.artifact);
const file = path.join(dir, frame.artifact.relativePath);
assert.equal((await stat(file)).mode & 0o777, 0o600);
assert(Buffer.from(frame.data).equals(await readFile(file)));
const decoded = Bun.spawnSync([
  ffmpeg, "-nostdin", "-v", "error", "-i", file, "-vf", "scale=1:1:flags=area,format=rgb24",
  "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "pipe:1",
], { stdout: "pipe", stderr: "ignore" });
assert.equal(decoded.exitCode, 0);
assert.equal(decoded.stdout.length, 3);
for (const [index, expected] of [0x35, 0xa9, 0x6e].entries()) {
  assert(Math.abs(decoded.stdout[index]! - expected) <= 5, `Unexpected captured pixel: ${[...decoded.stdout]}`);
}
const wrongDir = path.join(dir, "wrong-size");
const wrongView = { ...observation, run: path.basename(wrongDir) };
await mkdir(path.join(wrongDir, "macro"), { recursive: true, mode: 0o700 });
await writeFile(path.join(wrongDir, "macro/observation.json"), JSON.stringify(wrongView), { mode: 0o600 });
const incorrect = await openTrustedFrameCapture({ ...settings, dir: wrongDir, width: 1279 });
assert.deepEqual(await incorrect(wrongView, signal, "wrong-shape-1"),
  { cause: "unavailable", failure: "unexpected_dimensions", adapter: "scrot" });
assert.deepEqual(await readdir(path.join(wrongDir, "macro-frames")), []);
assert.deepEqual(await readdir(path.join(dir, "macro-frames")), ["stable-1.jpg"]);
await frame.artifact.discard?.();
assert.deepEqual(await readdir(path.join(dir, "macro-frames")), []);
console.log("owned-visual-frame");
