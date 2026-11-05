import { dlopen, ptr } from "bun:ffi";

// Native timing assays bind Python/OS witnesses and separate Bun processes.
// Bun 1.3.14's process.hrtime.bigint() is process-relative, so it is not a
// cross-process CLOCK_MONOTONIC reading on this supported Linux runtime.
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
  throw new Error(
    "Native timing workflow clocks require 64-bit Linux CLOCK_MONOTONIC",
  );

const libc = dlopen("libc.so.6", {
  clock_gettime: { args: ["i32", "ptr"], returns: "i32" },
});
// A Linux LP64 timespec has two signed 64-bit fields. Keep its backing memory
// and address for the module lifetime; a synchronous read cannot interleave.
const timespec = new BigInt64Array(2);
const address = ptr(timespec);

export function osMonotonicNs(): bigint {
  if (libc.symbols.clock_gettime(1, address) !== 0)
    throw new Error("CLOCK_MONOTONIC could not be read");
  const seconds = timespec[0]!;
  const nanoseconds = timespec[1]!;
  if (seconds < 0n || nanoseconds < 0n || nanoseconds >= 1_000_000_000n)
    throw new Error("CLOCK_MONOTONIC returned an invalid timespec");
  return seconds * 1_000_000_000n + nanoseconds;
}
