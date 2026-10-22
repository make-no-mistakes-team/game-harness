import { expect, test } from "bun:test";
import { classifyVideoFrame } from "./video.ts";

function frame(capturedAt: number): ArrayBuffer {
  const buffer = new ArrayBuffer(36);
  const header = new DataView(buffer);
  header.setUint32(0, 0x47485631, true);
  header.setUint32(4, 1, true);
  header.setUint32(8, 1, true);
  header.setUint32(12, 4, true);
  header.setUint32(16, 1, true);
  header.setUint32(20, 1, true);
  header.setFloat64(24, capturedAt, true);
  return buffer;
}

test("aged valid frames are stale, and the next fresh frame is still admitted", () => {
  expect(classifyVideoFrame(frame(980_000), 1_000_000)).toBe("stale");
  expect(classifyVideoFrame(frame(999_950), 1_000_000)).toBe("fresh");
});

test("clock-shifted valid frames are stale rather than malformed", () => {
  expect(classifyVideoFrame(frame(1_020_000), 1_000_000)).toBe("stale");
  expect(classifyVideoFrame(frame(990_000), 1_000_000)).toBe("stale");
});

test("a frame queued before suspension is no longer drawable after it ages", () => {
  const queued = frame(1_000_000);
  expect(classifyVideoFrame(queued, 1_000_050)).toBe("fresh");
  expect(classifyVideoFrame(queued, 1_011_000)).toBe("stale");
});

test("malformed structure and nonbinary messages are not classified as stale", () => {
  const malformed = frame(980_000);
  new DataView(malformed).setUint32(0, 0, true);
  expect(classifyVideoFrame(malformed, 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame("not a binary frame", 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame(frame(Number.NaN), 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame(new ArrayBuffer(31), 1_000_000)).toBe("malformed");
});
