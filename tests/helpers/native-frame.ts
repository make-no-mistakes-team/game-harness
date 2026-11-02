import { expect } from "bun:test";
import { inflateSync } from "node:zlib";
import type { FrameScope } from "../../src/server/actor-frames.ts";
import { minecraftTestAdapter, minecraftTestBinding } from "./adapter-contract.ts";

const frameBinding = minecraftTestBinding(minecraftTestAdapter());

/** Owned native packet. Pixels are supplied in wire order, not display order. */
export function nativeFrame(options: { width?: number; height?: number; sequence?: number; capturedAt?: number; bottomUp?: boolean; pixels?: Uint8Array } = {}) {
  const { width = 2, height = 2, sequence = 1, capturedAt = Date.now(), bottomUp = false, pixels } = options;
  const frame = new Uint8Array(328 + width * height * 4);
  const header = new DataView(frame.buffer);
  header.setUint32(0, 0x47485632, true);
  header.setUint32(4, width, true);
  header.setUint32(8, height, true);
  header.setUint32(12, width * height * 4, true);
  header.setUint32(16, sequence, true);
  header.setUint32(20, Number(bottomUp), true);
  header.setFloat64(24, capturedAt, true);
  header.setUint32(316, 1, true);
  if (pixels) frame.set(pixels, 328);
  return frame;
}

// Independent narrow PNG reader: checks the standard wire format and CRCs rather
// than importing encoder helpers. Default assertions do not require FFmpeg.
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function decodeRgbaPng(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let cursor = 8, width = 0, height = 0;
  const chunks: string[] = [], idat: Buffer[] = [];
  while (cursor < png.length) {
    const length = png.readUInt32BE(cursor), end = cursor + 12 + length;
    expect(end).toBeLessThanOrEqual(png.length);
    const type = png.toString("ascii", cursor + 4, cursor + 8);
    const data = png.subarray(cursor + 8, cursor + 8 + length);
    expect(png.readUInt32BE(cursor + 8 + length)).toBe(crc32(png.subarray(cursor + 4, cursor + 8 + length)));
    chunks.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(data);
    cursor = end;
  }
  expect(chunks[0]).toBe("IHDR"); expect(chunks.at(-1)).toBe("IEND");
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe(height * (1 + width * 4));
  const pixels: number[] = [];
  for (let row = 0; row < height; row++) {
    expect(raw[row * (1 + width * 4)]).toBe(0);
    pixels.push(...raw.subarray(row * (1 + width * 4) + 1, (row + 1) * (1 + width * 4)));
  }
  return { width, height, pixels };
}
export const frameScope = (): FrameScope => ({ run_id: "run", world_id: "world", session_id: "session", life_id: 1, epoch: 1, generation: 1,
  native_boot_id: frameBinding.native_boot_id, compatibility_hash: frameBinding.compatibility_hash,
  space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, screen: null });
