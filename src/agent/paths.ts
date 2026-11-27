import path from "node:path";

export const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
export const DATA_DIR = path.resolve(
  process.env.GAMEHARNESS_DATA_DIR ?? path.join(PROJECT_ROOT, "local/runtime"),
);
export const APP_PORT = Number(process.env.GAMEHARNESS_PORT ?? 4317);
const desktop = process.env.GAMEHARNESS_DESKTOP === "1";
if (
  !Number.isInteger(APP_PORT) ||
  (APP_PORT === 0 ? !desktop : APP_PORT < 1024 || APP_PORT > 65535)
)
  throw new Error(
    "GAMEHARNESS_PORT must be 1024–65535, or 0 for an owned desktop backend",
  );
export let APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const OPERATOR_ORIGINS = [
  APP_ORIGIN,
  `http://localhost:${APP_PORT}`,
  ...(!desktop ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
];

export function setListeningPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("The backend did not obtain a valid listening port");
  APP_ORIGIN = `http://127.0.0.1:${port}`;
  OPERATOR_ORIGINS[0] = APP_ORIGIN;
  OPERATOR_ORIGINS[1] = `http://localhost:${port}`;
}
export const MINECRAFT_VERSION = "1.21.4" as const;
export const MINECRAFT_PORT = Number(
  process.env.GAMEHARNESS_MINECRAFT_PORT ?? 25565,
);
if (
  !Number.isInteger(MINECRAFT_PORT) ||
  MINECRAFT_PORT < 1024 ||
  MINECRAFT_PORT > 65535
)
  throw new Error("Invalid Minecraft port");

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export interface EvaluationPaths {
  /** Compact evaluation indexes and summaries; never heavy runtime evidence. */
  reportsRoot: string;
  /** Private worlds, dependencies, sessions and full evidence. */
  runtimeRoot: string;
  /** Durable reservations; independent of any individual run directory. */
  governanceRoot: string;
}

function xdgRoot(variable: string, fallback: string): string {
  const value = process.env[variable];
  // XDG requires absolute values. Ignore malformed values rather than putting
  // heavy/private artifacts in the current checkout through a relative base.
  return value && path.isAbsolute(value) ? value : path.join(homedir(), fallback);
}

/** Resolves paths without creating directories or changing application config.
 * GAMEHARNESS_DATA_DIR remains owned by the application/Electron launcher.
 */
export function evaluationPaths(
  projectRoot: string,
  overrides: Partial<EvaluationPaths> = {},
): EvaluationPaths {
  const resolved = path.resolve(projectRoot);
  // Canonicalize existing projects so opening a checkout through a symlink does
  // not accidentally create a new hypothesis ledger.
  let project = resolved;
  try { project = realpathSync(resolved); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const label = path.basename(project).replace(/[^a-zA-Z0-9_-]/g, "_") || "project";
  const scope = `${label}-${createHash("sha256").update(project).digest("hex").slice(0, 16)}`;
  const select = (key: keyof EvaluationPaths, variable: string, fallback: string) => {
    const value = overrides[key] ?? process.env[variable] ?? fallback;
    if (!value.trim()) throw new Error(`Evaluation ${key} must not be empty`);
    return path.resolve(project, value);
  };
  const paths = {
    reportsRoot: select("reportsRoot", "GAMEHARNESS_EVALUATION_REPORTS_ROOT", path.join(project, "reports/evaluation")),
    runtimeRoot: select("runtimeRoot", "GAMEHARNESS_EVALUATION_RUNTIME_ROOT", path.join(xdgRoot("XDG_CACHE_HOME", ".cache"), "gameharness/evaluation", scope, "runtime")),
    governanceRoot: select("governanceRoot", "GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT", path.join(xdgRoot("XDG_STATE_HOME", ".local/state"), "gameharness/evaluation", scope, "governance")),
  };
  const roots = Object.values(paths);
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++) {
    const first = roots[a]!;
    const second = roots[b]!;
    const relative = path.relative(first, second);
    const reverse = path.relative(second, first);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
        (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse)))
      throw new Error("Evaluation reports, runtime and governance roots must be separate, non-nested directories");
  }
  return paths;
}

import { dlopen, ptr } from "bun:ffi";

// Process-independent Linux time for native timing and execution-host coordination.
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
