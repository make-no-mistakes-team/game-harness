import { dlopen } from "bun:ffi";
import { readSync, writeSync } from "node:fs";
import { z } from "zod";
import { osMonotonicNs } from "./os-monotonic.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { PROJECTION_MESSAGE_BYTES, projectionReplySchema } from "./projection-writer-protocol.ts";

// Only this synchronous derived child blocks. Its normal stdin/stdout carry
// one job or metadata exchange at a time; no extra process-pipe custody exists.
const libc = dlopen("libc.so.6", { poll: { args: ["buffer", "u64", "i32"], returns: "i32" } });
const descriptor = new Int32Array(2);
const input = Buffer.alloc(PROJECTION_MESSAGE_BYTES + 1);
const decoder = new TextDecoder("utf-8", { fatal: true });
const responseSchema = z.object({ serial: z.int().positive(), reply: projectionReplySchema }).strict();
function wait(fd: number, events: number, deadline?: bigint): void {
  for (;;) {
    const remaining = deadline === undefined ? null : deadline - osMonotonicNs();
    if (remaining !== null && remaining <= 0n) throw new RuntimeFault("history_deadline", "Derived metadata request reached its original deadline");
    descriptor[0] = fd; descriptor[1] = events;
    const timeout = remaining === null ? -1 : Math.min(2_147_483_647, Math.max(1, Math.ceil(Number(remaining) / 1e6)));
    // Keep the mutable view visible across the native call. A cached numeric
    // address can leave this hot loop polling stale fd/events instead.
    const count = libc.symbols.poll(descriptor, 1, timeout);
    if (count <= 0) continue;
    const returned = descriptor[1]! >>> 16;
    if (returned & events) return;
    throw new Error("Derived metadata pipe closed");
  }
}
export function writeProjectionFrame(value: unknown, deadline: bigint): void {
  const output = Buffer.from(JSON.stringify(value) + "\n");
  if (output.byteLength > PROJECTION_MESSAGE_BYTES) throw new Error("Projection metadata exceeds its wire envelope");
  for (let offset = 0; offset < output.byteLength;) {
    wait(1, 4, deadline);
    offset += writeSync(1, output, offset, Math.min(4096, output.byteLength - offset));
  }
}
export function readProjectionFrame(deadline?: bigint): unknown {
  let length = 0;
  for (;;) {
    wait(0, 1, deadline);
    const read = readSync(0, input, length, input.byteLength - length, null);
    if (!read) throw new Error("Derived metadata owner closed before its reply");
    const newline = input.indexOf(10, length);
    length += read;
    if (newline !== -1 && newline < length) {
      if (newline !== length - 1) throw new Error("Projection metadata reply has trailing bytes");
      return JSON.parse(decoder.decode(input.subarray(0, newline)));
    }
    if (length >= input.byteLength) throw new Error("Projection metadata reply exceeds its wire envelope");
  }
}
export function projectionMetadataExchange(value: unknown, serial: number, deadline: bigint): unknown {
  writeProjectionFrame(value, deadline);
  const response = responseSchema.parse(readProjectionFrame(deadline));
  if (response.serial !== serial) throw new Error("Projection metadata reply has foreign ownership");
  if (!response.reply.ok) throw new RuntimeFault(response.reply.error.code, response.reply.error.message);
  return response.reply.value;
}
