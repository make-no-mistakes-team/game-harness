import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ReferenceResult } from "../src/evaluation/policy-reference.ts";
import type { StudyState } from "../src/evaluation/studies.ts";

// Full production runner/ledger in isolated child drivers. Only external OS/model/game
// dependency seams are substituted; protocol workers and sampling helpers are real PIDs.
// These are ownership/failure regressions, never synthetic gameplay evidence.
// Real timers here bound real cross-process marker/close events; fake timers cannot
// advance another PID's OS signals, pipes or filesystem notifications.
interface Observation {
  result: ReferenceResult | null;
  thrown: string | null;
  state: StudyState;
  prematureDrain: boolean;
  stateAtDrain: { pid: number; kind: string; closed: boolean }[] | null;
  activeAtReturn: { pid: number; kind: string }[];
  journalOpened: number;
  journalClosed: number;
  unhandled: string[];
  sdkSignal: string | null;
  imageInspected: boolean;
  workerStarts: number;
  test_teardown_joined: boolean;
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function runDriver(mode: string, signal?: "SIGINT" | "SIGTERM") {
  const root = mkdtempSync(join(tmpdir(), `gh-reference-${mode}-`)); roots.push(root);
  const driver = fileURLToPath(new URL("./helpers/reference-review-driver.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "--no-env-file", driver, root, mode], { stdout: "pipe", stderr: "pipe" });
  const extendedCleanup = ["sampler-ignore-term", "close-never-ack", "held-final-sampler"].includes(mode);
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  let exited = false;
  void child.exited.then(() => { exited = true; });
  const waitMarker = async (name: string) => {
    const deadline = performance.now() + 10000;
    while (!existsSync(join(root, `${name}.json`))) {
      if (exited || performance.now() >= deadline) throw new Error(`Isolated driver did not reach ${name}; stderr=${await err}`);
      await delay(5);
    }
  };
  const timeout = setTimeout(() => {
    writeFileSync(join(root, "release-close.json"), "true");
    writeFileSync(join(root, "release-hash.json"), "true");
    child.kill("SIGKILL");
  }, extendedCleanup ? 40000 : 18000);
  try {
    if (signal) {
      await waitMarker("environment-close-requested");
      expect(existsSync(join(root, "final-behavior-response.json"))).toBe(true);
      child.kill(signal);
      await waitMarker("signal-received");
      writeFileSync(join(root, "release-close.json"), "true");
    }
    const [status, stdout, stderr] = await Promise.all([child.exited, out, err]);
    const reportPath = join(root, "driver-report.json");
    const expectedStatus = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0;
    if (status !== expectedStatus || !existsSync(reportPath))
      throw new Error(`Isolated production-runner driver failed (${status}): ${stderr}\n${stdout}; retained=${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "missing"}; root=${root}`);
    const observed = JSON.parse(readFileSync(reportPath, "utf8")) as Observation;
    if (signal) {
      expect(observed.sdkSignal).toBe(signal);
      expect(existsSync(join(root, "sdk-postmortem-owner.json"))).toBe(true);
      expect(observed.journalClosed).toBe(observed.journalOpened);
    }
    expect(observed.test_teardown_joined).toBe(true);
    return { root, observed };
  } finally {
    clearTimeout(timeout);
    writeFileSync(join(root, "release-close.json"), "true");
    writeFileSync(join(root, "release-hash.json"), "true");
    if (!exited) { child.kill("SIGKILL"); await child.exited; }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`F4 ${signal} during final container close cannot normally settle success`, async () => {
  const { observed } = await runDriver(signal === "SIGINT" ? "sigint" : "sigterm", signal);
  expect(observed.result?.reference_status).not.toBe("passed");
  expect(observed.result?.terminal).toBe("interrupted");
  expect(observed.state.attempts[0]!.state).toBe("interrupted");
  expect(observed.state.attempts[0]!.interruption).toContain(signal);
  expect(observed.prematureDrain).toBe(false);
}, 20000);

test("F4 study deadline during final container close is retained as limit, not success", async () => {
  const { observed } = await runDriver("deadline");
  expect(observed.result?.reference_status).not.toBe("passed");
  expect(observed.result?.terminal).toBe("limit");
  expect(observed.state.attempts[0]!.settlement?.outcome.goal_verified).not.toBe(true);
  expect(observed.state.attempts[0]!.settlement?.stop_reason).toBe("allowance_exhausted");
}, 20000);

for (const mode of ["late-error", "late-duplicate", "late-exit"]) test(`F5 ${mode} after final valid response remains a boundary failure after removal`, async () => {
  const { root, observed } = await runDriver(mode);
  expect(existsSync(join(root, "final-behavior-response.json"))).toBe(true);
  expect(observed.result?.reference_status).not.toBe("passed");
  expect(observed.result?.failures.join(" ")).toMatch(/F5|duplicate|transport|closed|exited|19/i);
  expect(observed.state.attempts[0]!.settlement?.outcome.platform_status).not.toBe("pass");
  expect(observed.activeAtReturn).toEqual([]);
}, 20000);

test("F6 independent sampler failure cannot release ownership while a real sibling helper remains blocked", async () => {
  const { root, observed } = await runDriver("sampler-failure");
  expect(existsSync(join(root, "blocked-helper-started.json"))).toBe(true);
  expect(observed.prematureDrain).toBe(false);
  expect(observed.activeAtReturn).toEqual([]);
  if (observed.state.attempts[0]!.cleanup.confirmed)
    expect(observed.stateAtDrain?.every(owner => owner.closed)).toBe(true);
  expect(observed.result?.failures.join(" ")).toContain("F6 immediate independent sampling failure");
}, 20000);

for (const mode of ["journal-write", "journal-sync", "report-write"]) test(`F7 ${mode} failure closes evidence and retains a durable non-success outcome`, async () => {
  const { observed } = await runDriver(mode);
  expect(observed.journalOpened).toBe(1);
  expect(observed.journalClosed).toBe(1);
  const attempt = observed.state.attempts[0]!;
  expect(attempt.state).not.toBe("reserved");
  const reason = attempt.interruption ?? attempt.settlement?.outcome.classification_reason.join(" ") ?? "";
  expect(reason).toMatch(/F7|ENOSPC|EIO/i);
  expect(attempt.settlement?.outcome.goal_verified).not.toBe(true);
  expect(observed.prematureDrain).toBe(false);
  expect(observed.activeAtReturn).toEqual([]);
  expect(attempt.cleanup.confirmed).toBe(true);
  expect(observed.unhandled).toEqual([]);
}, 20000);

test("F9 raw owned cgroup RAM includes inactive file cache, unlike Docker CLI working-set display", async () => {
  const { root, observed } = await runDriver("memory-cache");
  expect(existsSync(join(root, "final-behavior-response.json"))).toBe(true);
  expect(observed.result?.terminal).toBe("completed");
  expect(observed.result?.failures).toEqual([]);
  // Each raw memory.current is 8MiB (including 7MiB inactive_file); CLI displays 1MiB.
  expect(observed.result?.actual.peak_rss_bytes).toBe(4096 + 2 * 8388608);
  expect(observed.result?.actual.ram_measurement_scope).toMatch(/cgroup|raw|cache/i);
}, 20000);

test("F10 setup expiry during a held real artifact read prevents image inspection and every worker launch", async () => {
  const { root, observed } = await runDriver("setup-deadline");
  expect(existsSync(join(root, "hash-read-held.json"))).toBe(true);
  expect(observed.result?.setup_status).toBe("failed");
  expect(observed.result?.failures.join(" ")).toMatch(/setup|deadline|allocation/i);
  expect(observed.imageInspected).toBe(false);
  expect(observed.workerStarts).toBe(0);
  expect(observed.result?.actual.inferences).toBe(0);
}, 20000);

test("R1 SIGTERM-ignoring sampling sibling is escalated and joined before bounded failure settlement", async () => {
  const { root, observed } = await runDriver("sampler-ignore-term");
  expect(existsSync(join(root, "blocked-helper-started.json"))).toBe(true);
  expect(existsSync(join(root, "blocked-helper-ignored-sigterm.json"))).toBe(true);
  expect(observed.prematureDrain).toBe(false);
  expect(observed.activeAtReturn).toEqual([]);
  expect(observed.result?.reference_status).not.toBe("passed");
  expect(observed.result?.failures.join(" ")).toContain("F6 immediate independent sampling failure");
  expect(observed.state.attempts[0]!.state).not.toBe("reserved");
  expect(existsSync(join(root, "environment-forced-removal.json"))).toBe(true);
  expect(existsSync(join(root, "policy-forced-removal.json"))).toBe(true);
  expect(observed.stateAtDrain?.every(owner => owner.closed)).toBe(true);
  expect(observed.journalClosed).toBe(observed.journalOpened);
}, 45000);

for (const mode of ["close-never-ack", "held-final-sampler"]) test(`R2 ${mode} cannot consume the force-removal allocation for either owned container`, async () => {
  const { root, observed } = await runDriver(mode);
  expect(existsSync(join(root, "final-behavior-response.json"))).toBe(true);
  if (mode === "close-never-ack") expect(existsSync(join(root, "environment-close-requested.json"))).toBe(true);
  else {
    expect(existsSync(join(root, "blocked-helper-started.json"))).toBe(true);
    expect(existsSync(join(root, "blocked-helper-ignored-sigterm.json"))).toBe(true);
  }
  const start = JSON.parse(readFileSync(join(root, "final-behavior-response.json"), "utf8")).at_ms;
  for (const role of ["environment", "policy"]) {
    const marker = join(root, `${role}-forced-removal.json`);
    expect(existsSync(marker)).toBe(true);
    const removal = JSON.parse(readFileSync(marker, "utf8"));
    expect(removal.at_ms).toBeGreaterThanOrEqual(start);
    expect(removal.at_ms - start).toBeLessThan(30000);
  }
  expect(observed.activeAtReturn).toEqual([]);
  expect(observed.prematureDrain).toBe(false);
  expect(observed.stateAtDrain?.every(owner => owner.closed)).toBe(true);
  expect(observed.result?.reference_status).not.toBe("passed");
  expect(observed.result?.failures.length).toBeGreaterThan(0);
  expect(observed.state.attempts[0]!.state).not.toBe("reserved");
  expect(observed.state.attempts[0]!.settlement?.outcome.goal_verified).not.toBe(true);
  expect(observed.journalClosed).toBe(observed.journalOpened);
}, 45000);

test("R3 a healthy final in-flight sampler finishes its existing grace and retains measurement without a platform fault", async () => {
  const { root, observed } = await runDriver("responsive-final-sampler");
  const started = JSON.parse(readFileSync(join(root, "responsive-sampler-started.json"), "utf8"));
  const final = JSON.parse(readFileSync(join(root, "final-behavior-response.json"), "utf8"));
  expect(started.at_ms).toBeLessThanOrEqual(final.at_ms);
  expect(existsSync(join(root, "responsive-sampler-completed.json"))).toBe(true);
  expect(existsSync(join(root, "responsive-sampler-stopped-before-grace.json"))).toBe(false);
  const finished = JSON.parse(readFileSync(join(root, "responsive-sampler-completed.json"), "utf8"));
  expect(finished.at_ms).toBeGreaterThanOrEqual(final.at_ms);
  expect(finished.at_ms - final.at_ms).toBeLessThan(250);
  expect(observed.result?.actual.peak_rss_bytes).toBe(4096 + 2 * 16777216);
  expect(observed.result?.terminal).toBe("completed");
  expect(observed.result?.failures).toEqual([]);
  expect(observed.state.attempts[0]!.settlement?.outcome.platform_status).toBe("pass");
  expect(observed.activeAtReturn).toEqual([]);
  expect(observed.prematureDrain).toBe(false);
  expect(observed.state.attempts[0]!.cleanup.confirmed).toBe(true);
  expect(observed.stateAtDrain?.every(owner => owner.closed)).toBe(true);
  for (const role of ["environment", "policy"]) expect(existsSync(join(root, `${role}-forced-removal.json`))).toBe(true);
  expect(observed.journalClosed).toBe(observed.journalOpened);
}, 20000);
