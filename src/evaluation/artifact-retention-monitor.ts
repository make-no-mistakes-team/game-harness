import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ArtifactRetentionOptions } from "./artifact-retention.ts";

export interface ArtifactCapacitySample {
  runId: string;
  bytes: number;
  occupancyBytes: number;
  reservedBytes: number;
}

/** Run the full recursive capacity check off the gameplay/event-loop thread.
 * The promise settles ONLY after the child close event, including timeout/abort.
 * Caller owns scheduling (no overlapping checks) and MUST fence producers on rejection.
 * Stop/cleanup aborts the current check and awaits this same promise before closing inventory.
 */
export function checkArtifactCapacity(
  inventoryOptions: Omit<ArtifactRetentionOptions, "now">,
  runId: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ArtifactCapacitySample> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) return Promise.reject(new Error("Capacity check requires a finite positive timeoutMs"));
  if (options.signal?.aborted) return Promise.reject(new Error(`Artifact capacity check cancelled: ${String(options.signal.reason)}`));
  const request = JSON.stringify({ options: inventoryOptions, runId });
  if (Buffer.byteLength(request) > 64 * 1024) return Promise.reject(new Error("Artifact capacity worker request exceeds its finite byte bound"));
  const { promise, resolve, reject } = Promise.withResolvers<ArtifactCapacitySample>();
    const child = spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("./artifact-retention-check-worker.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
      // Capacity accounting needs neither credentials nor provider/discovery configuration.
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" },
    });
    let stdout = "", stderr = "", outputBytes = 0, failure: Error | null = null;
    let escalation: NodeJS.Timeout | undefined;
    const terminate = (error: Error) => {
      failure ??= error;
      if (child.exitCode !== null || child.signalCode !== null || escalation) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 250);
    };
    const abort = () => terminate(new Error(`Artifact capacity check cancelled: ${String(options.signal?.reason ?? "aborted")}`));
    const timer = setTimeout(() => terminate(new Error("Artifact capacity check timed out; sample refused")), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    // Cover an abort between the pre-spawn check and listener installation.
    if (options.signal?.aborted) abort();
    child.on("error", error => { failure ??= error; });
    child.stdin.on("error", error => { failure ??= error; });
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      outputBytes += chunk.length;
      if (outputBytes > 16 * 1024) { terminate(new Error("Artifact capacity worker exceeded its finite output bound")); return; }
      if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(escalation); options.signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`Artifact capacity refused: ${stderr.trim() || `worker exited ${String(code)}`}`)); return; }
      try {
        const sample = JSON.parse(stdout) as ArtifactCapacitySample;
        if (sample.runId !== runId || ![sample.bytes, sample.occupancyBytes, sample.reservedBytes].every(value => Number.isSafeInteger(value) && value >= 0))
          throw new Error("Malformed artifact capacity worker sample");
        resolve(sample);
      } catch (error) { reject(error); }
    });
    child.stdin.end(request);
  return promise;
}
