import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function acceptanceLifecycle(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "gameharness-acceptance-lifecycle-")); roots.push(root);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/acceptance-lifecycle.fixture.ts"), mode, root], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "runtime") },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 12000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const expectedExit = mode === "deadline" || mode === "manifest-failure" || mode.startsWith("image-") || mode.startsWith("development-") ? 0 : mode === "sigterm" ? 143 : 130;
    if (exit !== expectedExit) throw new Error(`Isolated acceptance ${mode} failed (${exit}, expected ${expectedExit}): ${stderr}\n${stdout}`);
    const line = stdout.split("\n").find(value => value.startsWith("ACCEPTANCE_RESULT "));
    if (!line) throw new Error(`Missing actual acceptance lifecycle evidence: ${stderr}\n${stdout}`);
    return JSON.parse(await readFile(join(root, "fixture-result.json"), "utf8"));
  } finally { clearTimeout(deadline); }
}

for (const mode of ["manifest-failure", "manifest-failure-sigint"]) {
  test(`${mode} joins the actual observer reader before Store close despite a cached manifest rejection`, async () => {
    const result = await acceptanceLifecycle(mode);
    expect(result.manifestPersistenceError).toContain("EEXIST");
    expect(result.result.failure).toContain("EEXIST");
    expect(result.result.platform_complete).toBe(false);
    expect(result.report.results).toHaveLength(0);
    expect(result.attempts).toEqual([expect.objectContaining({ state: "interrupted", settlement: null })]);
    expect(result.report.cleanup_confirmed).toBe(false);
    expect(result.report.resource_cleanup).toContainEqual({ resource: "private_model_evidence", closed: false });
    expect(result.report.resource_cleanup).toContainEqual({ resource: "store", closed: true });
    expect(result.report.private_model_evidence_failures).toEqual([
      expect.stringContaining("EEXIST"), expect.stringContaining("EEXIST"),
    ]);
    expect(result.readerBeforeClose.child.pid).toBeGreaterThan(0);
    expect(result.readerBeforeClose.child.closedHostMs).toBeNull();
    expect(result.readerAliveWhileHeld).toBe(true);
    expect(result.storeClosedWhileReaderHeld).toBe(false);
    expect(result.returnedWhileReaderHeld).toBe(false);
    expect(result.readerAtStoreClose).toMatchObject({ closed: true, active: false, queued: 0 });
    for (const stamp of ["exitObservedHostMs", "stdoutDrainObservedHostMs", "closedHostMs"]) {
      expect(result.readerAtStoreClose.child[stamp]).toBeNumber();
      expect(result.readerAtStoreClose.child[stamp]).toBeLessThanOrEqual(result.storeClosedAt);
    }
    expect(result.report.cleanup_budget_ms).toBe(300);
    expect(result.nextWorlds).toBe(0);
    expect(result.unchangedAfterReturn).toBe(true);
    expect(result.unhandled).toEqual([]);
  }, 15000);
}

test("a synthetic renderer exits when its fixture owner is hard-killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-acceptance-lifecycle-")); roots.push(root);
  const child = Bun.spawn([process.execPath, "--no-env-file",
    join(import.meta.dir, "helpers/acceptance-lifecycle.fixture.ts"), "orphan-parent-death", root], {
    stdout: "ignore", stderr: "ignore", env: { ...process.env, GAMEHARNESS_DATA_DIR: join(root, "runtime") },
  });
  let rendererPid: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline && rendererPid === undefined) {
      try { rendererPid = Number(await readFile(join(root, "runtime/evidence/case-collect_wood-recording/renderer.pid"), "utf8")); }
      catch { await Bun.sleep(10); }
    }
    expect(rendererPid).toBeDefined();
    child.kill("SIGKILL"); await child.exited;
    const closedBy = performance.now() + 1000;
    while (alive(rendererPid!) && performance.now() < closedBy) await Bun.sleep(10);
    expect(alive(rendererPid!)).toBe(false);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    if (rendererPid !== undefined && alive(rendererPid)) process.kill(rendererPid, "SIGKILL");
  }
}, 12000);

test("Minecraft development retains a custom completion claim without inventing verification", async () => {
  const result = await acceptanceLifecycle("development-custom-finish");
  expect(result.report.results[0]).toMatchObject({
    prompt: "Collect wood, make a table and keep four planks.",
    verification: null, declared_verifier: null, completion_claim: "model_reported_unverified",
    outcome: { goal_verified: null },
  });
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0].state).toBe("settled");
  expect(result.fixtureConditions.seed).toBe("20261026");
  expect(result.report.cleanup_confirmed).toBe(true);
  expect({ unchanged: result.unchangedAfterReturn, changes: result.postReturnChanges }).toEqual({ unchanged: true, changes: [] });
  expect(result.report.cost_to_result).toBeUndefined();
  expect(result.report.diagnostic_history).toEqual([expect.objectContaining({
    attempt_id: result.attempts[0].attemptId, goal_verified: null,
  })]);
}, 15000);

test("Minecraft development bounds real SDK transport and keeps the stone criterion for the full request", async () => {
  const result = await acceptanceLifecycle("development-request-cap-non-goal");
  expect(result.providerCalls).toBe(1);
  expect(result.report.development_host_admissions).toBe(1);
  expect(result.report.development_request_ownership).toEqual([expect.objectContaining({ drained: true })]);
  expect(result.report.results[0].verifier_manifest.goal.goal_id).toBe("craft_stone_pickaxe");
  expect(result.report.results[0].outcome.goal_verified).toBe(false);
  expect(result.attempts).toHaveLength(1);
  expect(result.report.cleanup_confirmed).toBe(true);
}, 15000);

for (const mode of ["sigint", "sigterm", "deadline"]) {
  test(`${mode} while offline postprocessing is pending interrupts the durable attempt and joins all case work`, async () => {
    const result = await acceptanceLifecycle(mode);
    expect(result.rendererStarted).toBe(true);
    expect(result.providerCalls).toBeGreaterThan(0);
    expect(result.result.platform_complete).toBe(false);
    expect(result.result.failure).not.toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ state: "interrupted", settlement: null,
      interruption: mode === "sigint" ? "operator_sigint" : mode === "sigterm" ? "operator_sigterm" : "entire_sample_deadline" });
    expect(result.starts).toBe(1);
    expect(result.nextWorlds).toBe(0);
    expect(result.rendererAlive).toBe(false);
    expect(result.lateWrites).toBe(0);
    expect(result.unchangedAfterReturn).toBe(true);
    expect(result.unhandled).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]).toMatchObject({ status: "interrupted",
      reason: mode === "sigint" ? "operator_sigint" : mode === "sigterm" ? "operator_sigterm" : "entire_sample_deadline" });
    // A platform interruption does not undo an independently observed inventory
    // gain. Persist the case fact before replay work, separately from settlement.
    expect(result.report.interrupted_case).toMatchObject({ scenario_id: "collect_wood",
      baseline: { inventory: {} },
      verification: { adapter_id: "fabric-owned-client", status: "verified", reason: "own_inventory_gain",
        verifier_id: "minecraft_possession_v2", verifier_version: 2 },
      verifier_manifest: { goal: { adapter_id: "fabric-owned-client", goal_id: "collect_wood",
        verifier: { id: "minecraft_possession_v2", version: 2 } }, baseline: { inventory: {} } } });
    expect(result.report.interrupted_case.baseline.inventory).toEqual({});
    expect(result.report.interrupted_case.verifier_manifest.baseline.inventory).toEqual({});
    const evidenceRefs = result.report.interrupted_case.verification.evidence_refs;
    expect(evidenceRefs).toHaveLength(1);
    expect(evidenceRefs[0]).toMatch(/^observe_.+/);
    const observations = result.journals.flatMap((journal: string) => journal.trim().split("\n").map(line => JSON.parse(line)))
      .filter((record: { kind: string }) => record.kind === "authorized_evaluation_observation");
    expect(observations.some((record: { value: { observation: { schema_version: number; data: { player: {
      inventory: { name: string; count: number }[] } } } } }) => record.value.observation.schema_version === 3 &&
      record.value.observation.data.player.inventory.some(item => item.name === "oak_log" && item.count === 1))).toBe(true);
    expect(result.journals.join("\n")).toContain('"name":"oak_log"');
    expect(result.journals.join("\n")).not.toContain("LOCAL_SYNTHETIC_PROVIDER_ONLY");
  }, 15000);
}

test("an outer interruption after a passing case never reports the whole platform sample complete", async () => {
  const result = await acceptanceLifecycle("complete-persistence");
  expect(result.rendererStarted).toBe(true);
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]).toMatchObject({ state: "settled",
    settlement: { outcome: { platform_status: "pass", goal_verified: true } } });
  expect(result.result.outcomes).toEqual([expect.objectContaining({ platform_status: "pass", goal_verified: true })]);
  expect(result.report.results[0]).toMatchObject({ host_baseline_preserved: true,
    verification: { adapter_id: "fabric-owned-client", status: "verified", reason: "own_inventory_gain",
      verifier_id: "minecraft_possession_v2", verifier_version: 2 } });
  expect(result.report.results[0].verification.evidence_refs).toHaveLength(1);
  expect(result.result.failure).not.toBeNull();
  expect(result.result.platform_complete).toBe(false);
  expect(result.nextWorlds).toBe(0);
  expect(result.lateWrites).toBe(0);
  expect(result.unchangedAfterReturn).toBe(true);
  expect(result.unhandled).toEqual([]);
}, 15000);

for (const [mode, admissions] of [["image-before-first", 0], ["image-after-settled", 1]] as const) {
  test(`${mode} actor PNG preparation fault settles a platform failure without another request or attempt`, async () => {
    const result = await acceptanceLifecycle(mode);
    expect(result.providerCalls).toBe(admissions);
    expect(result.starts).toBe(1);
    expect(result.nextWorlds).toBe(0);
    expect(result.result.platform_complete).toBe(false);
    expect(result.result.failure).toBeNull();
    const expectedOutcome = { platform_status: "fail", provider_status: admissions ? "ok" : "not_called",
      agent_status: admissions ? "goal_not_verified" : "not_run", goal_verified: admissions ? false : null };
    expect(result.result.outcomes).toEqual([expect.objectContaining(expectedOutcome)]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ state: "settled", interruption: null,
      settlement: { outcome: expectedOutcome, usage: { admissions, reported_messages: admissions,
        event_coverage: "complete", consumption_coverage: admissions ? "unknown" : "known" } } });
    expect(result.report.results).toHaveLength(1);
    expect(result.report.results[0]).toMatchObject({ outcome: expectedOutcome, host_baseline_preserved: true,
      usage: { admissions, reported_messages: admissions }, verification: { adapter_id: "fabric-owned-client", status: "incomplete",
        verifier_id: "minecraft_possession_v2", verifier_version: 2, evidence_refs: [], reason: "eligible_inventory_gain_not_observed" } });
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0].evidence_complete).toBe(true);
    const records = result.journals.flatMap((journal: string) => journal.trim().split("\n").map(line => JSON.parse(line)));
    const events = records.filter((record: { kind: string }) => record.kind === "store_event")
      .map((record: { value: unknown }) => record.value);
    expect(events.filter((event: { type: string }) => event.type === "runtime.model_observation_failed")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "model.call")).toHaveLength(admissions);
    expect(events.filter((event: { type: string }) => event.type === "model.request_settled")).toHaveLength(admissions);
    expect(events.some((event: { type: string }) => event.type === "model.request_unsettled")).toBe(false);
    if (admissions) expect(events.findIndex((event: { type: string }) => event.type === "runtime.model_observation_failed"))
      .toBeGreaterThan(events.findIndex((event: { type: string }) => event.type === "model.request_settled"));
    expect(result.lateWrites).toBe(0);
    expect(result.unchangedAfterReturn).toBe(true);
    expect(result.unhandled).toEqual([]);
  }, 15000);
}
