import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { ArtifactRetention } from "../src/evaluation/artifact-retention.ts";
import { checkArtifactCapacity } from "../src/evaluation/artifact-retention-monitor.ts";

// A worker must perform the actual recursive accounting; the returned promise joins
// its process even on cancellation, so cleanup cannot abandon an inventory writer.
test("off-main capacity accounting observes real producer writes and returns only its bounded sample", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-capacity-"));
  const options = { runtimeRoot: path.join(root, "runtime"), metadataRoot: path.join(root, "metadata"), protectedPaths: [path.join(root, "auth")], budgetBytes: 1000, freeSpaceFloorBytes: 0 };
  const inventory = new ArtifactRetention(options);
  try {
    const run = inventory.acquire({ reservationBytes: 20, headroomBytes: 0, attempt: { purpose: "development", declaration: "bounded" } });
    writeFileSync(path.join(run.directory, "video"), Buffer.alloc(19));
    expect(await checkArtifactCapacity(options, run.id, { timeoutMs: 10_000 })).toMatchObject({ runId: run.id, bytes: 19, occupancyBytes: 19, reservedBytes: 1 });
    writeFileSync(path.join(run.directory, "video"), Buffer.alloc(21));
    await expect(checkArtifactCapacity(options, run.id, { timeoutMs: 10_000 })).rejects.toThrow(/reservation/i);
    expect(existsSync(run.directory)).toBe(true);
    await expect(checkArtifactCapacity(options, run.id, { timeoutMs: 10_000, signal: AbortSignal.abort("operator_stop") })).rejects.toThrow(/operator_stop/);
  } finally { inventory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("capacity worker timeout is joined and refuses instead of claiming a healthy sample", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-capacity-timeout-"));
  const options = { runtimeRoot: path.join(root, "runtime"), metadataRoot: path.join(root, "metadata"), protectedPaths: [path.join(root, "auth")], budgetBytes: 1000, freeSpaceFloorBytes: 0 };
  const inventory = new ArtifactRetention(options);
  try {
    const run = inventory.acquire({ reservationBytes: 20, headroomBytes: 0, attempt: { purpose: "development", declaration: "bounded" } });
    // Holding the real SQLite write lock prevents worker admission/check settlement.
    const lock = new Database(path.join(options.metadataRoot, "artifact-retention.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    try { await expect(checkArtifactCapacity(options, run.id, { timeoutMs: 100 })).rejects.toThrow(/timed out/); }
    finally { lock.exec("ROLLBACK"); lock.close(); }
    expect(existsSync(run.directory)).toBe(true);
  } finally { inventory.close(); rmSync(root, { recursive: true, force: true }); }
});
