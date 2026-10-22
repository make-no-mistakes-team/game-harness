import { describe, expect, test } from "bun:test";
import { inspectVideoFrame } from "../src/server/video.ts";

function frame(width: number, height: number, capturedAt: number): Uint8Array {
  const bytes = new Uint8Array(32 + width * height * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x47485631, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, width * height * 4, true);
  view.setUint32(16, 0xffffffff, true);
  view.setUint32(20, 1, true);
  view.setFloat64(24, capturedAt, true);
  return bytes;
}

describe("native video wire boundary", () => {
  test("decodes a complete frame from a sliced transport buffer without reading adjacent bytes", () => {
    const packet = frame(2, 3, 10000);
    const transport = new Uint8Array(packet.length + 19);
    transport.set(packet, 7);
    const decoded = inspectVideoFrame(
      transport.subarray(7, 7 + packet.length),
      10010,
    );
    expect(decoded).toEqual({
      width: 2,
      height: 3,
      sequence: 0xffffffff,
      bottomUp: true,
      capturedAt: 10000,
    });
  });

  test("rejects truncated payloads, mismatched lengths, impossible dimensions and unsupported flags", () => {
    const valid = frame(2, 3, 10000);
    expect(
      inspectVideoFrame(valid.subarray(0, valid.length - 1), 10010),
    ).toBeNull();
    for (const [offset, value] of [
      [0, 0],
      [4, 0],
      [4, 0xffffffff],
      [8, 1081],
      [12, 1],
      [20, 2],
    ]) {
      const malformed = valid.slice();
      new DataView(malformed.buffer).setUint32(offset!, value!, true);
      expect(inspectVideoFrame(malformed, 10010)).toBeNull();
    }
  });

  test("rejects nonfinite, future and expired capture times rather than presenting them as fresh video", () => {
    for (const capturedAt of [NaN, Infinity, -1, 12001, 4999])
      expect(inspectVideoFrame(frame(1, 1, capturedAt), 10000)).toBeNull();
    expect(inspectVideoFrame(frame(1, 1, 5000), 10000)?.capturedAt).toBe(5000);
  });
});
