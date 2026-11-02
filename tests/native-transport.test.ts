import { expect, test } from "bun:test";
import { NativeFrameDecoder } from "../src/server/game-bridge.ts";
import { nativeFrame } from "./helpers/native-frame.ts";

function frame(sequence = 1) {
  return Buffer.from(nativeFrame({ sequence, bottomUp: true, pixels: new Uint8Array(16).fill(127) }));
}

test("split native headers and payloads emit only complete bounded messages", () => {
  const seen: Buffer[] = [];
  const decoder = new NativeFrameDecoder((b) => seen.push(b));
  const b = frame();
  decoder.push(b.subarray(0, 5));
  decoder.push(b.subarray(5, 33));
  expect(seen).toHaveLength(0);
  decoder.push(b.subarray(33, 327));
  expect(seen).toHaveLength(0);
  decoder.push(b.subarray(327, 329));
  expect(seen).toHaveLength(0);
  decoder.push(b.subarray(329));
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
      new NativeFrameDecoder(() => {}).push(b.subarray(0, 328)),
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

test("transport owns the full capture header and pixels after producer buffers are reused", () => {
  const seen: Buffer[] = [], original = frame(5), expected = Buffer.from(original);
  const decoder = new NativeFrameDecoder(packet => seen.push(packet));
  decoder.push(original);
  original.fill(0);
  decoder.push(frame(6));
  expect(seen[0]).toEqual(expected);
  expect([...seen[0]!.subarray(328)]).toEqual(Array(16).fill(127));
});

test("invalid capture schema, time ordering and unsafe counters fail on the header before a body", () => {
  const schema = frame(), ordering = frame(), counter = frame(), legacy = frame();
  schema.writeUInt32LE(2, 316);
  ordering.writeBigInt64LE(-1n, 40);
  counter.writeBigUInt64LE(9007199254740992n, 88);
  legacy.writeUInt32LE(0x47485631, 0);
  for (const packet of [schema, ordering, counter, legacy])
    expect(() => new NativeFrameDecoder(() => {}).push(packet.subarray(0, 328))).toThrow();
});

test("uint32 sequence wrap advances while duplicates and half-range-old packets fail closed", () => {
  const seen: number[] = [];
  const decoder = new NativeFrameDecoder(packet => seen.push(packet.readUInt32LE(16)));
  decoder.push(Buffer.concat([frame(0xfffffffe), frame(0xffffffff), frame(0), frame(1)]));
  expect(seen).toEqual([0xfffffffe, 0xffffffff, 0, 1]);
  expect(() => decoder.push(frame(1))).toThrow();
  const old = new NativeFrameDecoder(() => {});
  old.push(frame(1));
  expect(() => old.push(frame(0x80000001))).toThrow();
});
