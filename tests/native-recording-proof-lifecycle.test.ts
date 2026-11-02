import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("requested capture duration is a real full window before successful native close", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-native-proof-duration-")); roots.push(root);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/native-recording-proof-lifecycle.fixture.ts"), "SIGINT", root, "close"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "data"),
      PROOF_EXTRA_ARGS: JSON.stringify(["--duration-ms", "7000"]) },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 18000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 130) throw new Error(`Duration fixture exited ${code}: ${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(value => value.startsWith("PROOF_LIFECYCLE_RESULT "));
    if (!line) throw new Error(`Missing duration result: ${stderr}\n${stdout}`);
    const result = JSON.parse(line.slice("PROOF_LIFECYCLE_RESULT ".length));
    expect(result.caseBeforeClose.status).toBe("passed");
    expect(result.caseBeforeClose.replay_timing.expected_ms).toBeGreaterThanOrEqual(7000);
    expect(result.caseBeforeClose.replay_timing.actual_ms).toBeGreaterThanOrEqual(7000);
    expect(result.caseBeforeClose.replay_timing.final_hold_ms).toBeGreaterThan(0);
    expect(result.caseBeforeClose.recording.stored_frames).toBeGreaterThan(0);
  } finally { clearTimeout(deadline); }
}, 20000);

for (const args of [
  ["--duration-ms", "0"], ["--duration-ms", "1800001"], ["--duration-ms", "1000.5"],
  ["--duration-ms", "Infinity"], ["--duration-ms"], ["--duration-ms", "1000", "--duration-ms", "2000"],
  ["--duration-ms", "1200000"], ["--evidence-profile"], ["--natural-start", "--natural-start"],
]) {
  test(`proof rejects invalid or undeclared resource scope before native preparation: ${JSON.stringify(args)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gameharness-native-proof-preflight-")); roots.push(root);
    const child = Bun.spawn([process.execPath, "--no-env-file",
      join(import.meta.dir, "helpers/native-recording-proof-lifecycle.fixture.ts"), "SIGINT", root, "preflight"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "data"),
        PROOF_EXTRA_ARGS: JSON.stringify(args) },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Preflight fixture exited ${code}: ${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(value => value.startsWith("PROOF_PREFLIGHT_RESULT "));
    if (!line) throw new Error(`Missing preflight result: ${stderr}\n${stdout}`);
    const result = JSON.parse(line.slice("PROOF_PREFLIGHT_RESULT ".length));
    expect(result.nativeCreations).toBe(0);
    expect(result.error).not.toBeNull();
  });
}

test("a complete explicit profile with insufficient nominal frames is refused before native creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-native-proof-profile-")); roots.push(root);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/native-recording-proof-lifecycle.fixture.ts"), "SIGINT", root, "preflight"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "data"),
      PROOF_EXTRA_ARGS: JSON.stringify(["--duration-ms", "1200000", "--evidence-profile", "evidence-profile.json"]),
      PROOF_PROFILE_CONTENT: JSON.stringify({ schema_version: 1, recording: { maxPendingRawBytes: 134217728,
        maxFrames: 36000, maxStoredFrameBytes: 34359738368, maxDurationMs: 2000000 },
        journal: { maxTextBytes: 2147483648, maxPendingBytes: 16777216, maxImageBytes: 34359738368, maxImages: 12000 },
        render_timeout_ms: 300000 }) },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Profile fixture exited ${code}: ${stderr}\n${stdout}`);
  const line = stdout.split("\n").find(value => value.startsWith("PROOF_PREFLIGHT_RESULT "));
  if (!line) throw new Error(`Missing profile result: ${stderr}\n${stdout}`);
  expect(JSON.parse(line.slice("PROOF_PREFLIGHT_RESULT ".length))).toMatchObject({
    nativeCreations: 0, error: expect.stringContaining("Evidence profile"),
  });
});

for (const { label, args, maxDurationMs, maxFrames, admitted } of [
  { label: "short requested window cannot omit mandatory technical phases", args: ["--duration-ms", "1000"],
    maxDurationMs: 1100, maxFrames: 34, admitted: false },
  { label: "duration alone must cover the admitted phase allowance", args: ["--duration-ms", "1000"],
    maxDurationMs: 1100, maxFrames: 60000, admitted: false },
  { label: "frames independently cover the admitted phase allowance", args: ["--duration-ms", "1000"],
    maxDurationMs: 2000000, maxFrames: 34, admitted: false },
  { label: "one millisecond below the complete capture allowance", args: ["--duration-ms", "1000"],
    maxDurationMs: 81099, maxFrames: 2434, admitted: false },
  { label: "one frame below the complete capture allowance", args: ["--duration-ms", "1000"],
    maxDurationMs: 81100, maxFrames: 2433, admitted: false },
  { label: "exact complete capture allowance", args: ["--duration-ms", "1000"],
    maxDurationMs: 81100, maxFrames: 2434, admitted: true },
  { label: "default technical scope retains its current run cap", args: [],
    maxDurationMs: 299999, maxFrames: 9001, admitted: false },
  { label: "default natural scope retains its current run cap", args: ["--natural-start"],
    maxDurationMs: 59999, maxFrames: 1801, admitted: false },
  { label: "default technical scope accepts its complete current allowance", args: [],
    maxDurationMs: 300000, maxFrames: 9001, admitted: true },
  { label: "default natural scope accepts its complete current allowance", args: ["--natural-start"],
    maxDurationMs: 60000, maxFrames: 1801, admitted: true },
  { label: "long scope frames include its existing phase allowance", args: ["--duration-ms", "1200000"],
    maxDurationMs: 2000000, maxFrames: 38403, admitted: false },
  { label: "unchanged long profile covers the complete 30 minute scope", args: ["--duration-ms", "1800000"],
    maxDurationMs: 2000000, maxFrames: 60000, admitted: true },
]) {
  test(`complete capture-scope preflight: ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gameharness-native-proof-phase-profile-")); roots.push(root);
    const child = Bun.spawn([process.execPath, "--no-env-file",
      join(import.meta.dir, "helpers/native-recording-proof-lifecycle.fixture.ts"), "SIGINT", root, "preflight"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "data"),
        PROOF_EXTRA_ARGS: JSON.stringify([...args, "--evidence-profile", "evidence-profile.json"]),
        PROOF_PROFILE_CONTENT: JSON.stringify({ schema_version: 1, recording: { maxPendingRawBytes: 134217728,
          maxFrames, maxStoredFrameBytes: 34359738368, maxDurationMs },
          journal: { maxTextBytes: 2147483648, maxPendingBytes: 16777216, maxImageBytes: 34359738368, maxImages: 12000 },
          render_timeout_ms: 300000 }) },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Capture-scope fixture exited ${code}: ${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(value => value.startsWith("PROOF_PREFLIGHT_RESULT "));
    if (!line) throw new Error(`Missing capture-scope result: ${stderr}\n${stdout}`);
    expect(JSON.parse(line.slice("PROOF_PREFLIGHT_RESULT ".length))).toMatchObject(admitted
      ? { nativeCreations: 1, error: "External native preparation must not be reached" }
      : { nativeCreations: 0, error: expect.stringContaining("Evidence profile") });
  });
}

test("signal aborts a declared 30 minute capture without waiting out a technical delay or reporting success", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-native-proof-abort-capture-")); roots.push(root);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/native-recording-proof-lifecycle.fixture.ts"), "SIGINT", root, "capture"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "data"),
      PROOF_EXTRA_ARGS: JSON.stringify(["--duration-ms", "1800000", "--evidence-profile", "evidence-profile.json"]),
      PROOF_PROFILE_CONTENT: JSON.stringify({ schema_version: 1, recording: { maxPendingRawBytes: 134217728,
        maxFrames: 60000, maxStoredFrameBytes: 34359738368, maxDurationMs: 2000000 },
        journal: { maxTextBytes: 2147483648, maxPendingBytes: 16777216, maxImageBytes: 34359738368, maxImages: 12000 },
        render_timeout_ms: 300000 }) },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 130) throw new Error(`Capture abort exited ${code}: ${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(value => value.startsWith("PROOF_LIFECYCLE_RESULT "));
    if (!line) throw new Error(`Missing capture interruption result: ${stderr}\n${stdout}`);
    const evidence = JSON.parse(line.slice("PROOF_LIFECYCLE_RESULT ".length));
    expect(evidence.result.pass).toBe(false);
    expect(evidence.report.pass).toBe(false);
    expect(evidence.report.cases[0].status).toBe("failed");
    expect(evidence.report.cases[0].elapsed_ms).toBeLessThan(1400);
    expect(evidence.report.recorder_cleanup).toMatchObject({ confirmed: true, deadline_reached: false });
    expect(evidence.report.capture_declaration.caps.runMs).toBeGreaterThan(1800000);
    expect(evidence.report.capture_declaration.caps.totalMs).toBeGreaterThan(2100000);
    expect(evidence.unchangedAfterReturn).toBe(true);
  } finally { clearTimeout(deadline); }
}, 12000);

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
