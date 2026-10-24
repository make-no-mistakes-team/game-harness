import { expect, test } from "bun:test";
import { randomFillSync } from "node:crypto";
import { ActorFrameSelector, encodeNativeFramePng } from "../src/server/actor-frames.ts";
import { decodeRgbaPng, frameScope, nativeFrame } from "./helpers/native-frame.ts";

const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], white = [255, 255, 255, 255];

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
