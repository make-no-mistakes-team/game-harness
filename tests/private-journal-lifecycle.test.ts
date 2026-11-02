import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateJournal } from "../src/evaluation/private-journal.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function journalFixture(limits: ConstructorParameters<typeof PrivateJournal>[3] = {}) {
  const root = await mkdtemp(join(tmpdir(), "gameharness-journal-bounds-")); roots.push(root);
  const stops: string[] = [];
  const journal = new PrivateJournal(root, "budget-run", (_run, reason) => stops.push(reason), limits);
  return { root, journal, stops, async finalize() {
    const result = await journal.finalize({ status: "completed", reason: "test_end" });
    return { result, manifest: JSON.parse(await readFile(join(root, result.manifest), "utf8")),
      records: (await readFile(join(root, result.journal), "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
  } };
}
const image = (value: string) => ({ type: "image", data: Buffer.from(value).toString("base64"), mimeType: "image/png" });

test("invalid journal limits reject before creating the evidence directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-invalid-journal-")); roots.push(root);
  for (const [ordinal, limits] of [
    { maxTextBytes: 0 }, { maxTextBytes: -1 }, { maxTextBytes: 0.5 },
    { maxPendingBytes: Number.NaN }, { maxPendingBytes: Infinity },
    { maxPendingBytes: 64 * 1024 ** 2 + 1 }, { maxTextBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxImages: 0 }, { maxImages: 12001 }, { maxImageBytes: 32 * 1024 ** 3 + 1 }, { unknown: 1 },
  ].entries()) {
    const directory = join(root, String(ordinal));
    let journal: PrivateJournal | undefined;
    try {
      expect(() => { journal = new PrivateJournal(directory, "invalid", () => {}, limits); }).toThrow();
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (journal) await journal.finalize({ status: "interrupted", reason: "test_cleanup" }); }
  }
});

test("configured image byte and count boundaries retain deduplicated artifacts and reserved failure evidence", async () => {
  for (const limits of [
    { maxImageBytes: 3, maxImages: 10, maxTextBytes: 100000, maxPendingBytes: 100000 },
    { maxImageBytes: 100, maxImages: 1, maxTextBytes: 100000, maxPendingBytes: 100000 },
  ]) {
    const f = await journalFixture(limits);
    expect(f.journal.append("context", image("abc"))).toBe(true);
    expect(f.journal.append("context", image("abc"))).toBe(true);
    expect(f.journal.append("context", image("d"))).toBe(false);
    const { result, manifest, records } = await f.finalize();
    expect(result.evidence_complete).toBe(false);
    expect(f.stops).toEqual(["private_image_evidence_capacity_bound"]);
    expect(manifest).toMatchObject({ image_bytes: 3, image_count: 1, pending_bytes: 0,
      peak_image_bytes: 3, limits: { max_text_bytes: 100000, max_pending_bytes: 100000,
        max_image_bytes: limits.maxImageBytes, max_images: limits.maxImages } });
    expect(manifest.peak_pending_bytes).toBeGreaterThan(3);
    expect(manifest.image_artifacts).toHaveLength(1);
    expect(await readFile(join(f.root, manifest.image_artifacts[0].file), "utf8")).toBe("abc");
    expect(manifest.image_bytes).toBe((await stat(join(f.root, manifest.image_artifacts[0].file))).size);
    expect(manifest.text_bytes).toBe((await stat(join(f.root, result.journal))).size);
    expect((await readdir(f.root)).filter(name => name.endsWith(".png"))).toHaveLength(1);
    expect(records.filter(record => record.kind === "context")).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({ kind: "evidence_failure", failures: ["private_image_evidence_capacity_bound"] });
    expect(manifest.omissions.length).toBeGreaterThan(0);
    expect(f.journal.append("late", image("e"))).toBe(false);
  }
});

test("per-image and pending image exhaustion never create an artifact or report reserved bytes as stored", async () => {
  for (const [limits, payload] of [
    [{ maxPendingBytes: 1024 }, "x".repeat(1025)],
    [{ maxPendingBytes: 4 * 1024 ** 2 }, "x".repeat(2 * 1024 ** 2 + 1)],
  ] as const) {
    const f = await journalFixture(limits);
    expect(f.journal.append("context", image(payload))).toBe(false);
    const { manifest, records } = await f.finalize();
    expect(f.stops).toEqual(["private_image_evidence_capacity_bound"]);
    expect(manifest).toMatchObject({ evidence_complete: false, image_bytes: 0, peak_image_bytes: 0,
      image_count: 0, accepted_image_bytes: 0, accepted_images: 0, pending_bytes: 0, peak_pending_bytes: 0 });
    expect(manifest.image_artifacts).toEqual([]);
    expect((await readdir(f.root)).filter(name => name.endsWith(".png"))).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "evidence_failure" });
  }
});

test("text and pending exhaustion remain distinct and finalization drains admitted evidence", async () => {
  for (const [limits, reason] of [
    [{ maxTextBytes: 256, maxPendingBytes: 100000 }, "private_journal_text_capacity_bound"],
    [{ maxTextBytes: 100000, maxPendingBytes: 256 }, "private_journal_pending_capacity_bound"],
  ] as const) {
    const f = await journalFixture(limits);
    expect(f.journal.append("visible", "retain")).toBe(true);
    expect(f.journal.append("visible", "x".repeat(256))).toBe(false);
    const finalization = f.journal.finalize({ status: "interrupted", reason: "capacity" });
    expect(f.journal.finalize({ status: "other", reason: "late" })).toBe(finalization);
    const result = await finalization;
    const manifest = JSON.parse(await readFile(join(f.root, result.manifest), "utf8"));
    const contents = await readFile(join(f.root, result.journal), "utf8");
    expect(contents).toContain("retain");
    expect(contents).toContain('"kind":"evidence_failure"');
    expect(manifest).toMatchObject({ status: "interrupted", reason: "capacity", evidence_complete: false,
      pending_bytes: 0, image_bytes: 0, image_count: 0 });
    expect(manifest.failures).toContain(reason);
    expect(manifest.peak_pending_bytes).toBeGreaterThan(0);
    expect(manifest.text_bytes).toBeGreaterThan(0);
    expect(manifest.peak_text_bytes).toBe(manifest.text_bytes);
  }
});

for (const mode of ["journal-marker", "journal-sync"]) {
  test(`${mode}: a failed final flush still closes its real file and retains incomplete evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gameharness-journal-lifecycle-")); roots.push(root);
    const child = Bun.spawn([process.execPath, "--no-env-file",
      join(import.meta.dir, "helpers/recording-lifecycle.fixture.ts"), mode, root], { stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (exit !== 0) throw new Error(`Isolated ${mode} fixture failed (${exit}): ${stderr}\n${stdout}`);
      const line = stdout.split("\n").find(value => value.startsWith("LIFECYCLE_RESULT "));
      if (!line) throw new Error(`Missing journal resource evidence: ${stderr}\n${stdout}`);
      const result = JSON.parse(line.slice("LIFECYCLE_RESULT ".length));
      expect(result.handles).toEqual([{ fd: -1, usable: false }]);
      expect(result.finalized.evidence_complete).toBe(false);
      expect(result.manifest).toMatchObject({ status: "interrupted", reason: "operator_sigint", evidence_complete: false });
      expect(result.manifest.failures).toContain("private_journal_flush_failed");
      expect(result.manifest.omissions.length).toBeGreaterThan(0);
      if (mode === "journal-marker") {
        // The secondary marker-write error must not erase the original cause.
        expect(result.manifest.failures).toContain("private_journal_text_capacity_bound");
        expect(result.stops).toContain("private_journal_text_capacity_bound");
      } else {
        expect(result.journal).toContain("RETAIN_PRIOR_EVIDENCE");
        expect(result.journal).toContain('"status":"interrupted"');
      }
    } finally { clearTimeout(deadline); }
  }, 7000);
}
