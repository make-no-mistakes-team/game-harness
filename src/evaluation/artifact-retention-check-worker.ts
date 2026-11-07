import { ArtifactRetention, type ArtifactRetentionOptions } from "./artifact-retention.ts";
import type { ArtifactCapacitySample } from "./artifact-retention-monitor.ts";

// Private subprocess entrypoint. No model, auth, native or runtime imports.
// Parent owns timeout/cancellation and joins the actual process close event.
let inventory: ArtifactRetention | undefined;
try {
  const request = await Bun.stdin.text();
  if (Buffer.byteLength(request) > 64 * 1024) throw new Error("Artifact capacity request exceeds finite byte bound");
  const input = JSON.parse(request) as { options: ArtifactRetentionOptions; runId: string };
  if (typeof input.runId !== "string") throw new Error("Artifact capacity run ID missing");
  inventory = new ArtifactRetention(input.options);
  const checked = inventory.checkCapacity(input.runId);
  const run = checked.runs.find(entry => entry.id === input.runId)!;
  const sample: ArtifactCapacitySample = { runId: run.id, bytes: run.bytes, occupancyBytes: checked.occupancyBytes, reservedBytes: checked.reservedBytes };
  process.stdout.write(JSON.stringify(sample));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)).slice(0, 4096));
  process.exitCode = 2;
} finally { inventory?.close(); }
