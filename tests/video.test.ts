import { describe, expect, test } from "bun:test";
import { inspectVideoFrame } from "../src/server/video.ts";
import { decodeNativeVideoHeader } from "../src/shared/video.ts";

function frame(width: number, height: number, capturedAt: number): Uint8Array {
  const bytes = new Uint8Array(328 + width * height * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x47485632, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, width * height * 4, true);
  view.setUint32(16, 0xffffffff, true);
  view.setUint32(20, 1, true);
  view.setFloat64(24, capturedAt, true);
  view.setUint32(316, 1, true);
  return bytes;
}

function renderedFrame(): Uint8Array {
  const bytes = new Uint8Array(328 + 2 * 3 * 4);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 0x47485632], [4, 2], [8, 3], [12, 24], [16, 17], [20, 1], [312, 1], [316, 1]])
    view.setUint32(offset!, value!, true);
  view.setFloat64(24, 10000, true);
  view.setBigInt64(32, 1000000000n, true);
  view.setBigInt64(40, 1001000000n, true);
  view.setBigInt64(48, 999000000n, true);
  for (const [offset, value] of [[56, 12n], [64, 23n], [72, 1n], [80, 3n], [88, 7n]] as const)
    view.setBigUint64(offset, value, true);
  view.setFloat64(96, 3, true);
  view.setFloat64(104, 66, true);
  view.setFloat64(112, -4, true);
  view.setFloat32(132, 1, true);
  view.setFloat64(136, 1.25, true);
  view.setFloat64(144, -.5, true);
  for (const start of [152, 216])
    for (const component of [0, 5, 10, 15]) view.setFloat32(start + component * 4, 1, true);
  view.setFloat64(320, .25, true);
  bytes.fill(127, 328);
  return bytes;
}

describe("native video wire boundary", () => {
  test("joins rendered camera evidence to its exact captured packet without using later player state", () => {
    expect(inspectVideoFrame(renderedFrame(), 10010)).toMatchObject({
      width: 2, height: 3, sequence: 17, capturedAt: 10000, headerBytes: 328,
      capture: {
        readback_started_ns: "1000000000", readback_finished_ns: "1001000000",
        client_tick: 12, render_invocation: 23, life_id: 1, space_epoch: 3, native_generation: 7,
        screen: null,
        render: { sampled_ns: "999000000", position: { x: 3, y: 66, z: -4 },
          yaw_radians: 1.25, pitch_radians: -.5, quaternion: [0, 0, 0, 1], tick_delta: .25 },
      },
    });
    const noWorldDraw = renderedFrame();
    new DataView(noWorldDraw.buffer).setUint32(312, 0, true);
    expect(inspectVideoFrame(noWorldDraw, 10010)).toMatchObject({ capture: { render: null } });
  });

  test("rejects reversed native capture time and counters that lose wire precision", () => {
    const reversed = renderedFrame(), unsafeCounter = renderedFrame();
    new DataView(reversed.buffer).setBigInt64(40, 999999999n, true);
    new DataView(unsafeCounter.buffer).setBigUint64(56, 9007199254740992n, true);
    expect(inspectVideoFrame(reversed, 10010)).toBeNull();
    expect(inspectVideoFrame(unsafeCounter, 10010)).toBeNull();
    expect(inspectVideoFrame(renderedFrame(), 10010)).not.toBeNull();
  });

  test("decodes a complete frame from a sliced transport buffer without reading adjacent bytes", () => {
    const packet = frame(2, 3, 10000);
    const transport = new Uint8Array(packet.length + 19);
    transport.set(packet, 7);
    const decoded = inspectVideoFrame(
      transport.subarray(7, 7 + packet.length),
      10010,
    );
    expect(decoded).toMatchObject({
      width: 2,
      height: 3,
      sequence: 0xffffffff,
      bottomUp: true,
      capturedAt: 10000,
      headerBytes: 328,
      capture: { schema_version: 1, render: null, screen: null },
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
      [312, 4],
      [316, 2],
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
    expect(inspectVideoFrame(frame(1, 1, 12000), 10000)?.capturedAt).toBe(12000);
  });

  test("structural decoding accepts a partial packet without wall-clock freshness and rejects legacy framing", () => {
    const packet = renderedFrame();
    expect(decodeNativeVideoHeader(packet.subarray(0, 328))).toMatchObject({ headerBytes: 328, capturedAt: 10000 });
    expect(decodeNativeVideoHeader(packet.subarray(0, 327))).toBeNull();
    expect(inspectVideoFrame(packet.subarray(0, 328), 10010)).toBeNull();
    const legacy = frame(1, 1, 10000);
    new DataView(legacy.buffer).setUint32(0, 0x47485631, true);
    expect(decodeNativeVideoHeader(legacy)).toBeNull();
    const trailing = new Uint8Array(packet.length + 1); trailing.set(packet);
    expect(inspectVideoFrame(trailing, 10010)).toBeNull();
  });

  test("native signed nanoseconds and capture-tail UUID retain every bit while all counters stay safe", () => {
    const packet = renderedFrame(), view = new DataView(packet.buffer);
    view.setBigInt64(32, -9007199254740993n, true);
    view.setBigInt64(40, -9007199254740991n, true);
    view.setBigInt64(48, -9007199254740994n, true);
    view.setBigUint64(280, 0x0123456789abcdefn, true);
    view.setBigUint64(288, 0xfedcba9876543210n, true);
    view.setBigUint64(296, 9007199254740991n, true);
    view.setBigUint64(304, 8n, true);
    view.setUint32(312, 3, true);
    expect(decodeNativeVideoHeader(packet)?.capture).toMatchObject({
      readback_started_ns: "-9007199254740993", readback_finished_ns: "-9007199254740991",
      render: { sampled_ns: "-9007199254740994" },
      screen: { screen_id: "01234567-89ab-cdef-fedc-ba9876543210", incarnation: 9007199254740991, revision: 8 },
    });
    for (const offset of [56, 64, 72, 80, 88, 296, 304]) {
      const malformed = packet.slice();
      new DataView(malformed.buffer).setBigUint64(offset, 9007199254740992n, true);
      expect(decodeNativeVideoHeader(malformed)).toBeNull();
    }
  });

  test("future render snapshots and nonfinite camera inputs never become trusted capture evidence", () => {
    const future = renderedFrame();
    new DataView(future.buffer).setBigInt64(48, 1000000001n, true);
    expect(decodeNativeVideoHeader(future)).toBeNull();
    for (const offset of [96, 104, 112, 136, 144, 320]) {
      const malformed = renderedFrame();
      new DataView(malformed.buffer).setFloat64(offset, NaN, true);
      expect(decodeNativeVideoHeader(malformed)).toBeNull();
    }
    for (const offset of [120, 124, 128, 132, ...Array.from({ length: 32 }, (_, i) => 152 + i * 4)]) {
      const malformed = renderedFrame();
      new DataView(malformed.buffer).setFloat32(offset, Infinity, true);
      expect(decodeNativeVideoHeader(malformed)).toBeNull();
    }
    const packet = renderedFrame(), decoded = decodeNativeVideoHeader(packet)!;
    expect(decoded.capture.render?.position_matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    new DataView(packet.buffer).setFloat64(96, 999, true);
    expect(decoded.capture.render?.position.x).toBe(3);
  });
});
