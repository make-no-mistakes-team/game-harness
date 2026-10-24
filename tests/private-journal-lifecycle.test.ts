import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

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
