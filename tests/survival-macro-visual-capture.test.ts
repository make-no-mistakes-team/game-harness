import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTrustedFrameCapture } from "../src/server/survival-macro/compose.ts";
import type { MacroObservation } from "../src/server/survival-macro/protocol.ts";

const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AH//Z", "base64");
const sha256 = createHash("sha256").update(jpeg).digest("hex");
const captureId = "vc-abcdef0123456789abcdef0123456789";

async function captureFixture({ nativeTimeoutMs = 450, visualReady = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-visual-capture-"));
  const macro = path.join(dir, "macro");
  const archive = path.join(dir, "macro-frames");
  const observation = {
    v: 1, run: path.basename(dir), life: 1, epoch: 5, tick: 10, goal: "stone_pickaxe", health: 20, food: 20,
    inventory: {}, opportunities: [], recent: [], quiescent: false,
    safety: { clear: true, revision: 2 },
    ...(visualReady ? { visualReady: true } : {}),
  } satisfies MacroObservation;
  const abort = new AbortController();
  const requestId = randomUUID();
  const requestPath = path.join(macro, "visual-capture.json");
  const resultPath = path.join(macro, "visual-capture-result.json");
  const stagePath = path.join(macro, `visual-frame-${requestId}.jpg`);
  const archived = path.join(archive, `${requestId}.jpg`);
  const write = (file: string, contents: string | Uint8Array) => writeFile(file, contents, { mode: 0o600, flag: "wx" });
  const publish = async (file: string, contents: string | Uint8Array) => {
    await write(`${file}.partial`, contents);
    await rename(`${file}.partial`, file);
  };
  await Promise.all([mkdir(macro, { mode: 0o700 }), mkdir(archive, { mode: 0o700 })]);
  await write(path.join(macro, "observation.json"), JSON.stringify(observation));
  let owned = true, x11Frames = 0;
  const capture = createTrustedFrameCapture({
    dir, width: 1, height: 1, signal: abort.signal, native: true, nativeTimeoutMs,
    assertDisplay: () => { if (!owned) throw new Error("Display ownership lost."); },
    readJpeg: async () => { x11Frames++; return { bytes: jpeg }; },
  });
  const captured = capture(observation, new AbortController().signal, requestId);
  async function request() {
    const until = performance.now() + 400;
    for (;;) {
      const text = await readFile(requestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (text !== undefined) return JSON.parse(text) as Record<string, unknown>;
      if (performance.now() >= until) throw new Error("Native frame request never appeared.");
      await delay(5);
    }
  }
  async function reply(changes?: Record<string, unknown>) {
    await publish(resultPath, JSON.stringify({
      ...await request(), status: "captured", captureId, renderFrame: 34, width: 1, height: 1, sha256, ...changes,
    }));
  }
  return {
    macro, archive, requestPath, resultPath, stagePath, archived, requestId, captured, observation,
    request, reply, publish, abort, x11Frames: () => x11Frames, loseDisplay: () => { owned = false; },
    clean: async () => {
      abort.abort();
      await captured.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("native capture binds and archives only the exact request's staged bytes", async () => {
  const f = await captureFixture();
  try {
    expect(await f.request()).toEqual({
      v: 1, run: f.observation.run, life: 1, epoch: 5, basisTick: 10, requestId: f.requestId,
    });
    await f.publish(f.stagePath, jpeg);
    await f.reply();
    const frame = await f.captured;
    expect(frame).toMatchObject({
      tick: 10, data: jpeg, captureSource: "native", visualBinding: { captureId, renderFrame: 34 },
      nativeCaptureMs: expect.any(Number), artifact: { sha256, relativePath: `macro-frames/${f.requestId}.jpg` },
    });
    expect(await readFile(f.archived)).toEqual(jpeg);
    expect(await readdir(f.macro)).toEqual(["observation.json"]);
    if (!("data" in frame) || !frame.artifact?.verify) throw new Error("No verified archive.");
    expect(await frame.artifact.verify()).toBe(true);
    await f.publish(f.archived, jpeg);
    expect(await frame.artifact.verify()).toBe(false);
    expect(f.x11Frames()).toBe(0);
  } finally { await f.clean(); }
});

test.each(["heartbeat", "different life", "different stance", "not ready"] as const)(
  "a %s during native readback does not reassign the image's captured basis",
  async transition => {
    const f = await captureFixture();
    try {
      await f.request();
      const fresh = {
        ...f.observation, tick: 12,
        ...(transition === "different life" ? { life: 2 } :
          transition === "different stance" ? { stance: 2 } :
            transition === "not ready" ? { visualReady: undefined } : {}),
      };
      await f.publish(path.join(f.macro, "observation.json"), JSON.stringify(fresh));
      await f.publish(f.stagePath, jpeg);
      await f.reply();
      const result = await f.captured;
      if (transition === "heartbeat") {
        expect(result).toMatchObject({ tick: 10, visualBinding: { captureId, renderFrame: 34 } });
      } else {
        expect(result).toMatchObject({ cause: "basis_changed", captureSource: "native", nativeOmission: "basis_changed" });
        expect("visualBinding" in result).toBe(false);
        expect(await readdir(f.archive)).toEqual([]);
      }
      expect(f.x11Frames()).toBe(0);
    } finally { await f.clean(); }
  },
);

test("a symlink cannot supply a matching native receipt", async () => {
  const f = await captureFixture();
  try {
    const request = await f.request();
    const foreign = path.join(f.archive, "foreign.json");
    await f.publish(f.stagePath, jpeg);
    const receipt = JSON.stringify({ ...request, status: "captured", captureId, renderFrame: 34, width: 1, height: 1, sha256 });
    await f.publish(foreign, receipt);
    await symlink(foreign, f.resultPath);
    expect(await f.captured).toMatchObject({ captureSource: "native", nativeOmission: "invalid_receipt" });
    expect(await readFile(foreign, "utf8")).toBe(receipt);
    expect(await readdir(f.archive)).toEqual(["foreign.json"]);
  } finally { await f.clean(); }
});

test.each(["wrong basis", "wrong dimensions", "replaced JPEG", "stage symlink", "oversize JPEG", "extra receipt field"] as const)(
  "a native receipt with %s never produces visual authority",
  async issue => {
    const f = await captureFixture();
    try {
      await f.request();
      if (issue === "stage symlink") {
        const foreign = path.join(f.archive, "foreign.jpg");
        await f.publish(foreign, jpeg);
        await symlink(foreign, f.stagePath);
      } else if (issue === "replaced JPEG") {
        await f.publish(f.stagePath, jpeg);
        const replacement = Buffer.from(jpeg);
        replacement[12] = 0;
        await f.publish(f.stagePath, replacement);
      } else {
        await f.publish(f.stagePath, issue === "oversize JPEG" ? Buffer.alloc(2 * 1024 * 1024 + 1) : jpeg);
      }
      await f.reply(issue === "wrong basis" ? { basisTick: 11 } :
        issue === "wrong dimensions" ? { width: 2 } : issue === "extra receipt field" ? { path: f.stagePath } : undefined);
      const result = await f.captured;
      expect("data" in result).toBe(false);
      expect(result).toMatchObject({ captureSource: "native",
        nativeOmission: issue === "wrong basis" || issue === "extra receipt field" ? "invalid_receipt" : "invalid_image" });
      await expect(access(f.archived)).rejects.toThrow();
      await expect(access(f.requestPath)).rejects.toThrow();
      if (issue === "stage symlink") expect(await readFile(path.join(f.archive, "foreign.jpg"))).toEqual(jpeg);
      expect(f.x11Frames()).toBe(0);
    } finally { await f.clean(); }
  },
);

test("a stale receipt for another request is not consumed or assigned to the timeout fallback", async () => {
  const f = await captureFixture({ nativeTimeoutMs: 150 });
  try {
    const staleId = randomUUID();
    await f.reply({ requestId: staleId });
    const result = await f.captured;
    expect(result).toMatchObject({ captureSource: "x11", nativeOmission: "timeout", data: jpeg });
    expect("visualBinding" in result).toBe(false);
    expect(JSON.parse(await readFile(f.resultPath, "utf8")).requestId).toBe(staleId);
    await expect(access(f.requestPath)).rejects.toThrow();
  } finally { await f.clean(); }
});

test("an ordinary unbound view skips the native wait and remains observation-only", async () => {
  const f = await captureFixture({ visualReady: false });
  try {
    const result = await f.captured;
    expect(result).toMatchObject({ captureSource: "x11", nativeOmission: "not_requested", data: jpeg });
    expect("visualBinding" in result).toBe(false);
    expect(await readdir(f.macro)).toEqual(["observation.json"]);
  } finally { await f.clean(); }
});

test("cancellation retracts the published request and owned stage without an image or fallback", async () => {
  const f = await captureFixture();
  try {
    await f.request();
    await f.publish(f.stagePath, jpeg);
    f.abort.abort(new Error("cancel visual request"));
    await expect(f.captured).rejects.toThrow("cancel visual request");
    expect(await readdir(f.macro)).toEqual(["observation.json"]);
    expect(await readdir(f.archive)).toEqual([]);
    expect(f.x11Frames()).toBe(0);
  } finally { await f.clean(); }
});

test("native capture never admits a staged image after the display owner is lost", async () => {
  const f = await captureFixture();
  try {
    await f.request();
    await f.publish(f.stagePath, jpeg);
    f.loseDisplay();
    await f.reply();
    await expect(f.captured).rejects.toThrow("Display ownership lost.");
    expect(await readdir(f.macro)).toEqual(["observation.json"]);
    expect(await readdir(f.archive)).toEqual([]);
  } finally { await f.clean(); }
});
