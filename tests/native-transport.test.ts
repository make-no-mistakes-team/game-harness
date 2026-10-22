import { expect, test } from "bun:test";
import { NativeFrameDecoder } from "../src/server/game-bridge.ts";

function frame(sequence = 1) {
  const b = Buffer.alloc(48);
  b.writeUInt32LE(0x47485631, 0);
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(2, 8);
  b.writeUInt32LE(16, 12);
  b.writeUInt32LE(sequence, 16);
  b.writeUInt32LE(1, 20);
  b.writeDoubleLE(Date.now(), 24);
  b.fill(127, 32);
  return b;
}

test("split native headers and payloads emit only complete bounded messages", () => {
  const seen: Buffer[] = [];
  const decoder = new NativeFrameDecoder((b) => seen.push(b));
  const b = frame();
  decoder.push(b.subarray(0, 5));
  decoder.push(b.subarray(5, 33));
  expect(seen).toHaveLength(0);
  decoder.push(b.subarray(33));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual(b);
});
test("coalesced native frames preserve independent complete messages", () => {
  const seen: Buffer[] = [];
  new NativeFrameDecoder((b) => seen.push(b)).push(
    Buffer.concat([frame(1), frame(2)]),
  );
  expect(seen).toHaveLength(2);
  expect(seen[1]!.readUInt32LE(16)).toBe(2);
});
test("oversized dimensions and mismatched payload are rejected before accepting a body", () => {
  for (const field of [4, 8, 12]) {
    const b = frame();
    b.writeUInt32LE(0xffffffff, field);
    expect(() =>
      new NativeFrameDecoder(() => {}).push(b.subarray(0, 32)),
    ).toThrow();
  }
});
test("bad magic, unknown flags and stale timestamps fail closed", () => {
  const bad = [frame(), frame(), frame()];
  bad[0]!.writeUInt32LE(0, 0);
  bad[1]!.writeUInt32LE(2, 20);
  bad[2]!.writeDoubleLE(Date.now() - 6000, 24);
  for (const b of bad)
    expect(() => new NativeFrameDecoder(() => {}).push(b)).toThrow();
});
test("late frame sequence cannot replace newer native evidence", () => {
  const decoder = new NativeFrameDecoder(() => {});
  decoder.push(frame(10));
  expect(() => decoder.push(frame(9))).toThrow();
});
