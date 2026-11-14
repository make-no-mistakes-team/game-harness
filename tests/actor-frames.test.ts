import { afterEach, expect, test } from "bun:test";
import { createHash, randomFillSync } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActorFrameSelector } from "../src/server/actor-frames.ts";
import { encodeNativeFramePng } from "../src/server/actor-frame-codec.ts";
import { ActorFrameEncodingClient } from "../src/server/actor-frame-client.ts";
import { ACTOR_FRAME_PROTOCOL_VERSION } from "../src/server/actor-frame-protocol.ts";
import { osMonotonicNs } from "../src/server/os-monotonic.ts";
import { decodeRgbaPng, frameScope, nativeFrame } from "./helpers/native-frame.ts";

const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], white = [255, 255, 255, 255];
const owners: ActorFrameEncodingClient[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });

test("native PNG has independently decoded dimensions, CRCs and corrected corner colors", async () => {
  for (const bottomUp of [false, true]) {
    const pixels = new Uint8Array(bottomUp ? [...blue, ...white, ...red, ...green] : [...red, ...green, ...blue, ...white]);
    const frame = nativeFrame({ capturedAt: 10000, sequence: 42, bottomUp, pixels });
    const transport = new Uint8Array(frame.length + 19); transport.set(frame, 7);
    const encoded = await encodeNativeFramePng(transport.subarray(7, 7 + frame.length), 10010);
    expect(encoded).toMatchObject({ sequence: 42, capturedAt: 10000, width: 2, height: 2 });
    expect(decodeRgbaPng(encoded.png)).toEqual({ width: 2, height: 2, pixels: [...red, ...green, ...blue, ...white] });
  }
});

test("native framebuffer alpha is ignored like the actual opaque game viewer", async () => {
  const frame = nativeFrame({ pixels: new Uint8Array([
    255, 0, 0, 0, 0, 255, 0, 127,
    0, 0, 255, 1, 255, 255, 255, 255,
  ]) });
  const encoded = await encodeNativeFramePng(frame);
  expect(decodeRgbaPng(encoded.png).pixels).toEqual([...red, ...green, ...blue, ...white]);
});

test("malformed, expired and future packets cannot become apparently current actor images", async () => {
  const valid = nativeFrame({ capturedAt: 10000 });
  const badMagic = valid.slice(); new DataView(badMagic.buffer).setUint32(0, 0, true);
  const badFlags = valid.slice(); new DataView(badFlags.buffer).setUint32(20, 2, true);
  for (const frame of [valid.subarray(0, valid.length - 1), badMagic, badFlags,
    nativeFrame({ capturedAt: 4999 }), nativeFrame({ capturedAt: 12001 })]) {
    await expect(encodeNativeFramePng(frame, 10000)).rejects.toThrow();
  }
});

test("cached PNG never bypasses freshness checks on a later selection", async () => {
  const frame = nativeFrame({ capturedAt: 10000 });
  await encodeNativeFramePng(frame, 10010);
  await expect(encodeNativeFramePng(frame, 16001)).rejects.toThrow();
});

test("actor selection exposes typed image separately from honest unsynchronized metadata", async () => {
  const scope = frameScope(), packet = nativeFrame({ sequence: 73 });
  const header = new DataView(packet.buffer);
  header.setBigUint64(72, 41n, true);
  header.setFloat64(96, 123.5, true);
  header.setFloat32(132, 1, true);
  header.setUint32(312, 1, true);
  const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope });
  const selected = await selector.select();
  expect(selected.images).toHaveLength(1);
  expect(selected.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(decodeRgbaPng(Buffer.from(selected.images[0]!.data, "base64")).width).toBe(2);
  expect(selected.metadata).toMatchObject({ sequence: 73, width: 2, height: 2, alignment: "unsynchronized",
    pixel_presentation: "opaque_rgb", host_selection_scope: scope });
  expect(selected.metadata.encoded_bytes).toBeGreaterThan(0);
  expect(selected.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(selected.metadata)).not.toContain(selected.images[0]!.data);
  expect(selected.metadata).not.toHaveProperty("capture_life_id");
  expect(selected.metadata).not.toHaveProperty("capture_native_boot_id");
  expect(selected.metadata).not.toHaveProperty("capture_space");
  expect(selected.metadata).not.toHaveProperty("capture_screen");
  expect(selected.metadata).not.toHaveProperty("synchronized");
  expect(selected.metadata).not.toHaveProperty("capture");
  expect(selected.metadata).not.toHaveProperty("render");
});

test("authority revoked during asynchronous encoding rejects rather than relabeling a prior-life image", async () => {
  let scope = frameScope();
  const packet = nativeFrame(), entered = Promise.withResolvers<void>();
  const encoded = await encodeNativeFramePng(packet), release = Promise.withResolvers<typeof encoded>();
  const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope,
    encode: async () => { entered.resolve(); return await release.promise; } });
  const selection = selector.select();
  await entered.promise;
  scope = { ...scope, life_id: 2, generation: 2 };
  release.resolve(encoded);
  await expect(selection).rejects.toThrow();
  // Invalidating the old packet must persist until a new packet is delivered.
  await expect(selector.select()).rejects.toThrow();
});

test("a buffered packet never selected before revocation cannot enter the replacement scope", async () => {
  let scope = frameScope();
  let packet = nativeFrame({ sequence: 1 });
  const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope });
  await selector.select();
  packet = nativeFrame({ sequence: 2 });
  scope = { ...scope, life_id: 2, generation: 2 };
  await expect(selector.select()).rejects.toThrow();
  packet = nativeFrame({ sequence: 3 });
  const fresh = await selector.select();
  expect(fresh.metadata.sequence).toBe(3);
  expect(fresh.metadata.host_selection_scope.life_id).toBe(2);
});

test("actor output over two MiB is rejected explicitly instead of stringified or silently omitted", async () => {
  const pixels = randomFillSync(new Uint8Array(1920 * 1080 * 4));
  const packet = nativeFrame({ width: 1920, height: 1080, pixels });
  const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: frameScope });
  await expect(selector.select()).rejects.toThrow();
});

test("image-enabled selection cannot silently return no image for absent or expired native evidence", async () => {
  for (const packet of [null, nativeFrame({ capturedAt: Date.now() - 6000 })]) {
    const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: frameScope });
    await expect(selector.select()).rejects.toThrow();
  }
});

test("default subprocess presentation exactly matches the shared codec without modifying or renewing native packets", async () => {
  for (const bottomUp of [false, true]) {
    const top = [255, 0, 0, 0, 0, 255, 0, 127], bottom = [0, 0, 255, 1, 255, 255, 255, 0];
    const packet = nativeFrame({ sequence: 49, bottomUp, pixels: new Uint8Array(bottomUp ? [...bottom, ...top] : [...top, ...bottom]) });
    const before = packet.slice(), scope = frameScope();
    const expected = await encodeNativeFramePng(packet);
    const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope });
    try {
      const selected = await selector.select();
      expect(selected.images[0]!.data).toBe(expected.png.toString("base64"));
      expect(selected.metadata).toMatchObject({ sequence: expected.sequence, capturedAt: expected.capturedAt,
        width: expected.width, height: expected.height, encoded_bytes: expected.png.length,
        sha256: createHash("sha256").update(expected.png).digest("hex"), host_selection_scope: scope });
      expect(decodeRgbaPng(Buffer.from(selected.images[0]!.data, "base64")).pixels).toEqual([...red, ...green, ...blue, ...white]);
      expect(packet).toEqual(before);
    } finally { await selector.close(); }
  }
});

test("actual subprocess completion cannot relabel an in-flight image after screen authority changes", async () => {
  let scope = frameScope(), packet = nativeFrame();
  const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope });
  try {
    const pending = selector.select();
    scope = { ...scope, screen: { screen_id: crypto.randomUUID(), incarnation: 1, revision: 1 } };
    packet = nativeFrame({ sequence: 2 });
    await expect(pending).rejects.toMatchObject({ code: "stale_context" });
    await expect(selector.select()).rejects.toMatchObject({ code: "stale_context" });
    packet = nativeFrame({ sequence: 3 });
    expect((await selector.select()).metadata.sequence).toBe(3);
  } finally { await selector.close(); }
});

test("cancelling startup joins the real child, refuses a waiting frame queue, and releases the owner slot", async () => {
  const owner = new ActorFrameEncodingClient(), abort = new AbortController();
  owners.push(owner);
  const options = { deadlineOsNs: osMonotonicNs() + 1_500_000_000n, signal: abort.signal };
  const pending = owner.encode(nativeFrame(), options);
  const pid = owner.snapshot().child_pid;
  expect(pid).not.toBeNull();
  expect(pid).not.toBe(process.pid);
  await expect(owner.encode(nativeFrame(), options)).rejects.toMatchObject({ code: "backend_unavailable" });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(owner.snapshot().active).toBe(false);
  expect(() => process.kill(pid!, 0)).toThrow();
  const result = await owner.encode(nativeFrame(), { deadlineOsNs: osMonotonicNs() + 1_500_000_000n });
  expect(result.encoded_bytes).toBeGreaterThan(0);
  expect(owner.snapshot().active).toBe(false);
});

test("child death and immediate owner close join startup and never admit a result or native fault authority", async () => {
  for (const mode of ["death", "close"] as const) {
    const owner = new ActorFrameEncodingClient();
    owners.push(owner);
    const pending = owner.encode(nativeFrame(), { deadlineOsNs: osMonotonicNs() + 1_500_000_000n });
    const pid = owner.snapshot().child_pid;
    expect(pid).not.toBeNull();
    // Register rejection ownership without awaiting Bun's promise matcher before
    // issuing the fault: a tiny image may finish while the matcher is waiting.
    void pending.catch(() => {});
    if (mode === "death") process.kill(pid!, "SIGKILL");
    else await owner.close();
    await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(owner.snapshot().active).toBe(false);
    expect(() => process.kill(pid!, 0)).toThrow();
    if (mode === "close")
      await expect(owner.encode(nativeFrame(), { deadlineOsNs: osMonotonicNs() + 1_500_000_000n })).rejects.toMatchObject({ code: "backend_unavailable" });
  }
});

test("original monotonic deadline kills and joins a stopped encoding process instead of renewing startup time", async () => {
  const owner = new ActorFrameEncodingClient();
  owners.push(owner);
  const pending = owner.encode(nativeFrame(), { deadlineOsNs: osMonotonicNs() + 100_000_000n });
  const pid = owner.snapshot().child_pid;
  expect(pid).not.toBeNull();
  process.kill(pid!, "SIGSTOP");
  await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(owner.snapshot().active).toBe(false);
  expect(() => process.kill(pid!, 0)).toThrow();
  await expect(owner.encode(nativeFrame(), { deadlineOsNs: osMonotonicNs() - 1n })).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(owner.snapshot().child_pid).toBeNull();
});

test("worker EOF cannot encode a truncated binary native frame", async () => {
  const child = spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("../src/server/actor-frame-worker.ts", import.meta.url))],
    { env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }, stdio: ["pipe", "pipe", "ignore"] });
  const closed = Promise.withResolvers<number | null>();
  let outputBytes = 0;
  child.stdout!.on("data", (part: Buffer) => { outputBytes += part.length; });
  child.on("error", () => {});
  child.stdin!.on("error", () => {});
  child.once("close", code => closed.resolve(code));
  const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
  try {
    const packet = nativeFrame(), metadata = Buffer.from(JSON.stringify({ v: ACTOR_FRAME_PROTOCOL_VERSION,
      frame_bytes: packet.length, received_at: Date.now(), deadline_os_ns: (osMonotonicNs() + 1_500_000_000n).toString() }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
    child.stdin!.write(prefix); child.stdin!.write(metadata); child.stdin!.end(packet.subarray(0, packet.length - 1));
    expect(await closed.promise).toBe(1);
    expect(outputBytes).toBe(0);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await closed.promise;
  }
});
