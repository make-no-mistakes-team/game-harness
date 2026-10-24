import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

for (const { signal, exit, reason, phase } of [
  { signal: "SIGINT", exit: 130, reason: "sigint", phase: "close" },
  { signal: "SIGTERM", exit: 143, reason: "sigterm", phase: "close" },
  { signal: "SIGINT", exit: 130, reason: "sigint", phase: "persistence" },
  { signal: "SIGTERM", exit: 143, reason: "sigterm", phase: "persistence" },
]) {
  test(`${signal} during successful proof's final ${phase} cannot restore private or returned PASS`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gameharness-native-proof-lifecycle-")); roots.push(root);
    const child = Bun.spawn([process.execPath, "--no-env-file",
      join(import.meta.dir, "helpers/native-recording-proof-lifecycle.fixture.ts"), signal, root, phase], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "data") },
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 12000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== exit) throw new Error(`Native proof ${signal} exited ${code}, expected SDK ${exit}: ${stderr}\n${stdout}`);
      const line = stdout.split("\n").find(value => value.startsWith("PROOF_LIFECYCLE_RESULT "));
      if (!line) throw new Error(`Missing native proof lifecycle evidence: ${stderr}\n${stdout}`);
      const evidence = JSON.parse(line.slice("PROOF_LIFECYCLE_RESULT ".length));
      if (phase === "persistence") {
        expect(evidence.nativeClosedBeforeSignal).toBe(true);
        expect(evidence.serializedPassingSnapshot).toMatchObject({ pass: true, recorder_cleanup: { confirmed: true } });
        expect(evidence.serializedPassingSnapshot.recorder_failure).toBeUndefined();
        expect(evidence.proofSettledWhileInterruptionWriteHeld).toBe(false);
      }
      // The actual proof reached its success branch before the held shutdown
      // or persistence await. Cancellation is the only failure here.
      expect(evidence.caseBeforeClose).toMatchObject({ status: "passed",
        recording: { status: "complete" }, replay: "replay.mp4" });
      expect(evidence.caseBeforeClose.replay_timing.actual_ms).toBeGreaterThan(3000);
      expect(evidence.report.cleanup).toBe(true);
      expect(evidence.report.recorder_cleanup).toMatchObject({ confirmed: true, deadline_reached: false });
      expect(evidence.report.cases).toHaveLength(1);
      expect(evidence.report.cases[0].status).toBe("passed");
      expect(evidence.report.pass).toBe(false);
      expect(evidence.result).toMatchObject({ pass: false, actual_provider_calls: 0 });
      expect(evidence.report.actual_provider_calls).toBe(0);
      expect(evidence.report.recorder_failure).toContain(`Recorder proof interrupted: ${reason}`);
      expect(evidence.report.recorder_events).toContainEqual(expect.objectContaining({
        event: "operator_interrupt", details: { reason },
      }));
      expect(evidence.unchangedAfterReturn).toBe(true);
    } finally { clearTimeout(deadline); }
  }, 15000);
}
