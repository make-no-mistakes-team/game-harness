import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readReferenceSupervision, referenceFileIdentity, referenceRemainingMs, referenceTreeIdentity } from "../src/evaluation/policy-reference.ts";

async function withDirectory(body: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "gh-reference-boundary-"));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function cgroup(directory: string) {
  const values = { "memory.max": "536870912", "pids.max": "32", "cpu.max": "100000 100000",
    "memory.current": "4096", "pids.current": "2", "cgroup.procs": "123\n456\n" };
  await Promise.all(Object.entries(values).map(([name, value]) => writeFile(join(directory, name), value)));
}

describe("kernel resource file interpretation, no native processes", () => {
  test("remaining helper time is an integer and expiry never disables its timeout", () => {
    const remaining = referenceRemainingMs(performance.now() + 60000.25);
    expect(Number.isSafeInteger(remaining)).toBe(true);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60001);
    expect(() => referenceRemainingMs(performance.now() - 1)).toThrow(/deadline/i);
  });
  test("requires actual hard limits and reports measured usage independently", async () => {
    await withDirectory(async directory => {
      await cgroup(directory);
      const result = await readReferenceSupervision(directory);
      expect(result.memory_limit_bytes).toBe(536870912);
      expect(result.rss_bytes).toBe(4096);
      expect(result.task_limit).toBe(32);
      expect(result.tasks).toBe(2);
      expect(result.cpu_limit).toBe(1);
      expect(result.processes).toBe(2);
    });
  });

  test.each([
    ["memory.max", "max"], ["memory.max", "536870913"], ["pids.max", "max"], ["pids.max", "33"],
    ["cpu.max", "max 100000"], ["cpu.max", "200000 100000"], ["memory.current", "N/A"], ["pids.current", "N/A"],
    ["memory.current", "536870913"], ["pids.current", "33"],
  ])("unknown or excessive %s is not resource admission", async (name, value) => {
    await withDirectory(async directory => {
      await cgroup(directory);
      await writeFile(join(directory, name!), value!);
      await expect(readReferenceSupervision(directory)).rejects.toThrow();
    });
  });
});

describe("trusted staged input hashing", () => {
  test("hashes actual bytes and changes tree identity after file tampering", async () => {
    await withDirectory(async directory => {
      await mkdir(join(directory, "source"));
      const file = join(directory, "source", "policy.bin");
      await writeFile(file, Buffer.from([0, 1, 255]));
      expect(await referenceFileIdentity(file)).toEqual({ bytes: 3, sha256: createHash("sha256").update(Buffer.from([0, 1, 255])).digest("hex") });
      const before = await referenceTreeIdentity(directory);
      await writeFile(file, Buffer.from([0, 2, 255]));
      expect(await referenceTreeIdentity(directory)).not.toBe(before);
    });
  });

  test("an already aborted admission does not open or hash a missing artifact", async () => {
    const controller = new AbortController();
    const reason = new Error("operator stopped before artifact reads");
    controller.abort(reason);
    await expect(referenceFileIdentity("/nonexistent-reference-artifact", controller.signal)).rejects.toBe(reason);
  });
});
