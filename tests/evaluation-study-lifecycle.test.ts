import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { invalidStudyProfiles } from "./helpers/study-manifest.ts";
import { isolatedStudyCheckout } from "./helpers/isolated-study-checkout.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function lifecycle(mode: string) {
  const owned = isolatedStudyCheckout(); roots.push(owned.caseRoot);
  const root = join(owned.caseRoot, "lifecycle-state");
  const child = Bun.spawn([process.execPath, "--no-env-file", join(owned.projectRoot, "tests/helpers/acceptance-lifecycle.fixture.ts"),
    `study-${mode}`, root, JSON.stringify(owned)], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "runtime") },
  });
  // OS signal/provider-drain integration needs a real process; this timer only contains a deadlock.
  const timer = setTimeout(() => child.kill("SIGKILL"), mode === "planning-stalled" ? 22_000 : 12_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const expected = mode === "sigint" || mode === "cancel-before-iterator" ? 130 : mode === "sigterm" ? 143 : 0;
    if (exit !== expected) throw new Error(`Study lifecycle ${mode} exited ${exit}, expected ${expected}: ${stderr}\n${stdout}`);
    return JSON.parse(await readFile(join(root, "fixture-result.json"), "utf8"));
  } finally { clearTimeout(timer); }
}

for (const mode of ["sigint", "sigterm", "deadline"]) {
  test(`study ${mode} retains early interruption, joins postprocessing and refuses all late settlement/next-slot work`, async () => {
    const result = await lifecycle(mode);
    expect(result.startupReservationSeen).toBe(true); expect(result.authReservationSeen).toBe(true);
    expect(result.providerCalls).toBeGreaterThan(0); expect(result.rendererStarted).toBe(true);
    expect(result.attempts).toEqual([]); // No fabricated diagnostic hypothesis to satisfy the runner.
    expect(result.study.attempts).toHaveLength(1);
    expect(result.study.attempts[0]).toMatchObject({ state: "interrupted", settlement: null,
      interruption: mode === "sigint" ? "operator_sigint" : mode === "sigterm" ? "operator_sigterm" : "entire_sample_deadline",
      cleanup: { confirmed: true } });
    expect(result.study.closure).not.toBeNull();
    expect(result.study.slots.slice(1).map((slot: { status: string }) => slot.status)).toEqual(["closed_unstarted", "closed_unstarted", "closed_unstarted"]);
    expect(result.nextWorlds).toBe(0); expect(result.starts).toBe(1);
    expect(result.rendererAlive).toBe(false); expect(result.lateWrites).toBe(0);
    expect(result.unchangedAfterReturn).toBe(true); expect(result.unhandled).toEqual([]);
    expect(result.result.platform_complete).toBe(false);
    expect(result.report).toMatchObject({ study_id: "synthetic-study-lifecycle" });
    expect(result.report).not.toHaveProperty("hypothesis_id");
    expect(result.report.interrupted_case).toMatchObject({ scenario_id: "collect_wood",
      verification: { adapter_id: "fabric-owned-client", status: "verified", reason: "own_inventory_gain",
        verifier_id: "minecraft_possession_v2", verifier_version: 2 } });
    expect(result.report.interrupted_case.verification.evidence_refs).toHaveLength(1);
    expect(result.report.interrupted_case.verification.evidence_refs[0]).toMatch(/^observe_.+/);
  }, 15_000);
}

for (const mode of ["startup-failure", "model-mismatch", "profile-motor-mismatch"]) {
  test(`study ${mode} preserves the scheduled startup outcome before any strategic transport`, async () => {
    const result = await lifecycle(mode);
    expect(result.startupReservationSeen).toBe(true); expect(result.authReservationSeen).toBe(true);
    expect(result.providerCalls).toBe(0); expect(result.nextWorlds).toBe(0);
    expect(result.attempts).toEqual([]); expect(result.study.attempts).toHaveLength(1);
    expect(result.study.attempts[0]).toMatchObject({ state: "settled", settlement: {
      outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called", goal_verified: null },
      stop_reason: "invalid_platform" }, cleanup: { confirmed: true } });
    expect(result.study.closure).toMatchObject({ reason: "invalid_platform" });
    expect(result.result.platform_complete).toBe(false); expect(result.lateWrites).toBe(0);
    expect(result.unchangedAfterReturn).toBe(true); expect(result.unhandled).toEqual([]);
  }, 15_000);
}

test("a pre-inference image platform failure closes remaining study slots without hiding the zero-request outcome", async () => {
  const result = await lifecycle("image-before-first");
  expect(result.startupReservationSeen).toBe(true); expect(result.authReservationSeen).toBe(true);
  expect(result.providerCalls).toBe(0); expect(result.starts).toBe(1); expect(result.nextWorlds).toBe(0);
  expect(result.attempts).toEqual([]); expect(result.study.attempts).toHaveLength(1);
  expect(result.study.attempts[0]).toMatchObject({ state: "settled", settlement: {
    outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called", goal_verified: null },
    usage: { admissions: 0 }, stop_reason: "invalid_platform" } });
  expect(result.study.closure).toMatchObject({ reason: "invalid_platform" });
  expect(result.lateWrites).toBe(0); expect(result.unchangedAfterReturn).toBe(true);
  expect(result.report.results[0]).toMatchObject({ host_baseline_preserved: true,
    verification: { adapter_id: "fabric-owned-client", status: "incomplete", reason: "eligible_inventory_gain_not_observed",
      verifier_id: "minecraft_possession_v2", verifier_version: 2, evidence_refs: [] } });
}, 15_000);

test("the actual acceptance Agent transport consumes the durable study gate, not just an after-call observer", async () => {
  const result = await lifecycle("request-cap");
  expect(result.startupReservationSeen).toBe(true); expect(result.authReservationSeen).toBe(true);
  expect(result.providerCalls).toBe(1);
  expect(result.attempts).toEqual([]);
  expect(result.study.attempts).toHaveLength(1);
  expect(result.study.attempts[0].requests).toHaveLength(1);
  expect(result.study.attempts[0].requests[0]).toMatchObject({ path: "strategic", state: "settled" });
  expect(result.study.attempts[0].cleanup).toMatchObject({ confirmed: true });
  expect(result.fixtureConditions).toMatchObject({ seed: "17", gamemode: "survival", difficulty: "normal",
    levelType: "minecraft:normal", structures: true, hardcore: false, suppliedInventory: false,
    consoleCommands: false, freshWorldPerCase: true });
  expect(result.report.results[0]).toMatchObject({ study_id: "synthetic-study-lifecycle", host_baseline_preserved: true,
    outcome: { platform_status: "pass", agent_status: "goal_verified", provider_status: "ok", goal_verified: true },
    verification: { adapter_id: "fabric-owned-client", status: "verified", reason: "own_inventory_gain",
      verifier_id: "minecraft_possession_v2", verifier_version: 2 } });
  expect(result.report.results[0].verification.evidence_refs).toHaveLength(1);
  expect(result.report.results[0]).not.toHaveProperty("hypothesis_id");
}, 15_000);

test("cold acceptance keeps actual run-local repair revisions private without reading or publishing sibling Store state", async () => {
  const result = await lifecycle("cold-isolation");
  expect(result.providerCalls).toBe(3);
  expect(result.coldIsolation).toEqual({ sibling_visible: false, actor_sibling_visible: false, sibling_store_unchanged: true,
    programs: [{ name: "slot-private-repair", version: 1 }, { name: "slot-private-repair", version: 2 }] });
  expect(result.study.closure).toBeNull();
  expect(result.study.attempts[0]).toMatchObject({ state: "settled", cleanup: { confirmed: true },
    settlement: { outcome: { platform_status: "pass", goal_verified: false }, stop_reason: null } });
  expect(result.report.results[0]).toMatchObject({ host_baseline_preserved: true,
    verification: { adapter_id: "fabric-owned-client", status: "incomplete", reason: "eligible_inventory_gain_not_observed",
      verifier_id: "minecraft_possession_v2", verifier_version: 2, evidence_refs: [] } });
  expect(result.attempts).toEqual([]);
}, 15_000);

test("cancellation at SDK stream acquisition joins the original unstarted iterator before durable interrupted cleanup returns", async () => {
  const result = await lifecycle("cancel-before-iterator");
  expect(result.providerCalls).toBe(1);
  expect(result.requestSignalAbortedBeforeRead).toBe(true);
  expect(result.originalIteratorReads).toBe(0);
  expect(result.originalIteratorReturns).toBe(1);
  expect(result.originalIteratorClosed).toBe(true);
  expect(result.returnedBeforeTransportRelease).toBe(false);
  expect(result.study.attempts).toHaveLength(1);
  expect(result.study.attempts[0]).toMatchObject({ state: "interrupted", settlement: null,
    interruption: "operator_sigint", cleanup: { confirmed: true } });
  expect(result.study.attempts[0].requests).toHaveLength(1);
  expect(result.study.attempts[0].requests[0].state).toBe("unknown");
  expect(result.nextWorlds).toBe(0); expect(result.lateWrites).toBe(0);
  expect(result.unchangedAfterReturn).toBe(true); expect(result.postReturnChanges).toEqual([]);
  expect(result.unhandled).toEqual([]);
}, 15_000);

test("the manifest request limit denies a real Agent's second transport after a successful non-goal tool round", async () => {
  const result = await lifecycle("request-cap-non-goal");
  const toolResults = result.journals.flatMap((journal: string) => journal.trim().split("\n").map(line => JSON.parse(line)))
    .filter((record: { kind: string; value: { type?: string; toolName?: string } }) =>
      record.kind === "visible_agent_event" && record.value.type === "tool_execution_end" && record.value.toolName === "program_write");
  expect(toolResults).toHaveLength(1);
  expect(toolResults[0].value.isError).toBe(false);
  expect(result.providerCalls).toBe(1);
  expect(result.study.attempts[0].requests).toHaveLength(1);
  expect(result.study.attempts[0].requests[0]).toMatchObject({ state: "settled", path: "strategic" });
  expect(result.study.attempts[0]).toMatchObject({ state: "settled", cleanup: { confirmed: true },
    settlement: { outcome: { platform_status: "pass", provider_status: "ok", goal_verified: false }, stop_reason: null } });
  expect(result.study.closure).toBeNull();
  expect(result.report.results[0]).toMatchObject({ host_baseline_preserved: true,
    verification: { adapter_id: "fabric-owned-client", status: "incomplete", reason: "eligible_inventory_gain_not_observed",
      verifier_id: "minecraft_possession_v2", verifier_version: 2, evidence_refs: [] } });
}, 15_000);

test("ordinary real scheduler planning_stalled failure retains a healthy platform and admits the next declared slot", async () => {
  // The real scheduler's two five-second idle continuations are the behavior
  // under test; the subprocess clock and production backoff are not replaced.
  const result = await lifecycle("planning-stalled");
  const stalls = result.journals.flatMap((journal: string) => journal.trim().split("\n").map(line => JSON.parse(line)))
    .filter((record: { kind: string; value: { type?: string } }) => record.kind === "store_event" && record.value.type === "scheduler.planning_stalled");
  expect(stalls).toHaveLength(1);
  expect(result.providerCalls).toBe(3);
  expect(result.report.results[0]).toMatchObject({ runtime_status: "failed", host_baseline_preserved: true,
    outcome: { platform_status: "pass", agent_status: "goal_not_verified", provider_status: "ok", goal_verified: false },
    verification: { adapter_id: "fabric-owned-client", status: "incomplete", reason: "eligible_inventory_gain_not_observed",
      verifier_id: "minecraft_possession_v2", verifier_version: 2, evidence_refs: [] } });
  expect(result.study.attempts[0]).toMatchObject({ state: "settled", cleanup: { confirmed: true }, settlement: { stop_reason: null } });
  expect(result.study.closure).toBeNull();
  expect(result.nextAdmission).toMatchObject({ admitted: true, slot: { repetition: 2 } });
  expect(result.study.attempts).toHaveLength(2);
  expect(result.study.attempts[1]).toMatchObject({ state: "reserved", settlement: null });
  expect(result.nextWorlds).toBe(0);
}, 25_000);

for (const entry of ["dispatcher", "direct"]) {
  for (const mode of ["source-mismatch", "manifest-mismatch", "missing-manifest", "missing-opt-ins",
    "admission-flags", "override-model", "override-budget", "lower-request-budget",
    ...invalidStudyProfiles().map(profile => profile.name)]) {
    test(`${entry} ${mode} refuses before auth/native/process setup and leaves the slot unconsumed`, async () => {
      const owned = isolatedStudyCheckout(); roots.push(owned.caseRoot);
      const root = join(owned.caseRoot, "rejection-state");
      const child = Bun.spawn([process.execPath, "--no-env-file", join(owned.projectRoot, "tests/helpers/study-rejection.fixture.ts"),
        entry, mode, root, JSON.stringify(owned)], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "runtime") },
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const result = JSON.parse(stdout);
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.externalCalls).toEqual([]);
      expect(result.reservedAttemptCount).toBe(0);
      if (result.study) expect(result.study.attempts).toEqual([]);
    }, 15_000);
  }
}
