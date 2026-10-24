import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvaluationConfig } from "../src/evaluation/config.ts";
import { evaluationPaths } from "../src/evaluation/paths.ts";
import { AttemptLedger, openGovernanceDatabase } from "../src/evaluation/policy.ts";
import { StudyLedger, summarizeStudyUsage, type AttemptReservation } from "../src/evaluation/studies.ts";
import { classifyEvaluation, usageMetrics } from "../src/evaluation/results.ts";
import { admissionOnlyOutcome, failedStudyOutcome, liveStudyManifest, studyManifest } from "./helpers/study-manifest.ts";

const roots: string[] = [], ledgers: StudyLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(live = false) {
  const root = mkdtempSync(join(tmpdir(), "gameharness-study-contract-")); roots.push(root);
  const manifest = live ? liveStudyManifest(root) : studyManifest(root);
  const governance = join(root, "governance");
  const ledger = new StudyLedger(governance, { projectRoot: root }); ledgers.push(ledger);
  return { root, governance, ledger, manifest };
}
function reopen(governance: string, projectRoot: string) {
  const ledger = new StudyLedger(governance, { projectRoot }); ledgers.push(ledger); return ledger;
}
function drain(ledger: StudyLedger, reservation: AttemptReservation) {
  ledger.confirmStudyResourceDrain(reservation, { requests_drained: true, runtime_closed: true, native_closed: true,
    evidence: ["local-test-owned-resources-drained"] });
}
function settle(ledger: StudyLedger, reservation: AttemptReservation, outcome = admissionOnlyOutcome) {
  ledger.settleStudyAttempt(reservation, { outcome, usage: null, evidence: ["local-storage-contract"], stop_reason: null });
  drain(ledger, reservation);
}
async function child(source: string) {
  const process = Bun.spawn([Bun.which("bun")!, "--no-env-file", "--eval", source], { stdout: "pipe", stderr: "pipe" });
  // OS-process deadlock containment, not a guessed wait for the assertion.
  const deadline = setTimeout(() => process.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" }); return JSON.parse(stdout);
  } finally { clearTimeout(deadline); }
}
const studyModule = fileURLToPath(new URL("../src/evaluation/studies.ts", import.meta.url));

// Removing the unique durable slot transaction must permit more than one winner here.
test("six independent processes reserve a declared slot exactly once and restart cannot reuse it", async () => {
  const { root, governance, ledger, manifest } = fixture();
  const ref = ledger.registerStudy(manifest), slot = manifest.schedule[0]!.slot;
  const reserve = () => child(`
    import { StudyLedger } from ${JSON.stringify(studyModule)};
    const ledger = new StudyLedger(${JSON.stringify(governance)}, { projectRoot: ${JSON.stringify(root)} });
    try { const reservation = ledger.reserveStudyAttempt(${JSON.stringify(ref)}, ${JSON.stringify(slot)});
      console.log(JSON.stringify({ admitted: true, id: reservation.reservationId }));
    } catch (error) { if (!/reserved|consumed|duplicate/i.test(String(error))) throw error;
      console.log(JSON.stringify({ admitted: false })); } finally { ledger.close(); }
  `);
  const results = await Promise.all(Array.from({ length: 6 }, reserve));
  expect(results.filter(result => result.admitted)).toHaveLength(1);
  expect(await reserve()).toEqual({ admitted: false });
  expect(reopen(governance, root).readStudy(ref).attempts).toHaveLength(1);
  expect(ledger.readStudy(ref).attempts[0]).toMatchObject({ state: "reserved", settlement: null });
}, 30_000);

test("registration is immutable and detached from caller mutation, including after outcomes", () => {
  const { ledger, manifest } = fixture();
  const ref = ledger.registerStudy(manifest);
  expect(ledger.registerStudy(structuredClone(manifest))).toEqual(ref);
  const altered = structuredClone(manifest); altered.task.text = "Change after registration";
  expect(() => ledger.registerStudy(altered)).toThrow(/immutable|registered|mismatch/i);
  manifest.allowances.per_attempt.host_requests = 1;
  expect(ledger.readStudy(ref).manifest.allowances.per_attempt.host_requests).toBe(2);
  const first = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot); settle(ledger, first);
  expect(() => ledger.registerStudy(altered)).toThrow(/immutable|registered|mismatch/i);
  expect(() => ledger.reserveStudyAttempt({ ...ref, manifestSha256: "0".repeat(64) }, manifest.schedule[1]!.slot)).toThrow(/manifest|identity|mismatch/i);
});

test("two ordinary study failures preserve remaining slots and cannot reset exhausted diagnostics in the same database", () => {
  const { root, governance, ledger, manifest } = fixture(true);
  const diagnostics = new AttemptLedger(governance, { projectRoot: root });
  try {
    const config = createEvaluationConfig({ discoveredModels: [{ id: "gpt-6-luna" }], purpose: "ordinary_acceptance",
      hypothesisId: "preserved-diagnostic", platformEvidenceRevision: "initial" });
    for (let index = 0; index < 2; index++) {
      const attempt = diagnostics.admitAttempt(config, { reportDirectory: `old-${index}` });
      diagnostics.settleAttempt(attempt.attemptId, { outcome: { ...failedStudyOutcome, classification_reason: [...failedStudyOutcome.classification_reason] }, usage: null, evidence: [] });
    }
    const before = JSON.stringify({ attempts: diagnostics.listAttempts(config.hypothesisId), revisions: diagnostics.listPlatformEvidence(config.hypothesisId) });
    const ref = ledger.registerStudy(manifest);
    for (const entry of manifest.schedule.slice(0, 2)) {
      const reservation = ledger.reserveStudyAttempt(ref, entry.slot);
      ledger.settleStudyAttempt(reservation, { outcome: failedStudyOutcome, usage: null, evidence: [], stop_reason: null }); drain(ledger, reservation);
    }
    expect(ledger.readStudy(ref).closure).toBeNull();
    expect(ledger.reserveStudyAttempt(ref, manifest.schedule[2]!.slot).slot.repetition).toBe(3);
    expect(() => diagnostics.admitAttempt(config, { reportDirectory: "new-directory" })).toThrow("Two unsuccessful");
    expect(JSON.stringify({ attempts: diagnostics.listAttempts(config.hypothesisId), revisions: diagnostics.listPlatformEvidence(config.hypothesisId) })).toBe(before);
    const database = new Database(join(governance, "attempts.sqlite"), { readonly: true });
    try { expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM hypotheses").get()!.count).toBe(1); }
    finally { database.close(); }
  } finally { diagnostics.close(); }
});

test("report/runtime relocation does not create a new study allowance or duplicate-slot identity", () => {
  const { root, governance, ledger, manifest } = fixture();
  const ref = ledger.registerStudy(manifest), slot = manifest.schedule[0]!.slot;
  const firstPaths = evaluationPaths(root, { governanceRoot: governance, reportsRoot: join(root, "reports-a"), runtimeRoot: join(root, "runtime-a") });
  const secondPaths = evaluationPaths(root, { governanceRoot: governance, reportsRoot: join(root, "reports-b"), runtimeRoot: join(root, "runtime-b") });
  ledger.reserveStudyAttempt(ref, slot, { reportDirectory: firstPaths.reportsRoot });
  expect(() => reopen(secondPaths.governanceRoot, root).reserveStudyAttempt(ref, slot, { reportDirectory: secondPaths.reportsRoot })).toThrow(/reserved|consumed|duplicate/i);
  expect(ledger.readStudy(ref).attempts).toHaveLength(1);
});

for (const field of ["source", "build", "dependencies", "profile", "permission", "task", "verifier"] as const) {
  test(`a changed ${field} file fails identity admission before a slot is consumed`, () => {
    const { root, ledger, manifest } = fixture(); const ref = ledger.registerStudy(manifest);
    const paths = { source: "src/platform.ts", build: "fixture-build.txt", dependencies: "bun.lock", profile: "profile.json", permission: "permission.txt", task: "task.txt", verifier: "verifier.txt" };
    writeFileSync(join(root, paths[field]), "different bytes after registration\n");
    expect(() => ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot)).toThrow(/identity|source|hash|mismatch|changed/i);
    expect(ledger.readStudy(ref).attempts).toHaveLength(0);
  });
}

test("registration validates referenced bytes, exact task identity and complete permission without creating a study", () => {
  const { root, ledger, manifest } = fixture();
  const badHash = structuredClone(manifest); badHash.identities.source[0]!.sha256 = "0".repeat(64);
  expect(() => ledger.registerStudy(badHash)).toThrow(/hash|identity|mismatch/i);
  const wrongTask = structuredClone(manifest); wrongTask.task.text = "not the referenced task";
  expect(() => ledger.registerStudy(wrongTask)).toThrow(/task|identity|mismatch/i);
  const missingPermission = structuredClone(manifest); missingPermission.permission.granted_by = "";
  expect(() => ledger.registerStudy(missingPermission)).toThrow(/permission|granted/i);
  expect(readFileSync(join(root, "src/platform.ts"), "utf8")).toBe("export const protocol = 1;\n");
  expect(ledger.registerStudy(manifest).studyId).toBe(manifest.study_id);
});

test("declared run-private program/notes repair does not mutate the frozen starting-system claim or cancel another slot", () => {
  const { root, ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const first = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const privateRoot = join(root, "runtime", first.reservationId);
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(privateRoot, "agent-program.js"), "export const repaired = true; // local adaptation fixture only\n");
  writeFileSync(join(privateRoot, "private-notes.txt"), "Private first-slot repair lineage; never actor input for another slot.\n");
  ledger.settleStudyAttempt(first, { outcome: failedStudyOutcome, usage: null, evidence: [privateRoot], stop_reason: null }); drain(ledger, first);
  expect(ledger.readStudy(ref).manifest.execution.adaptation).toBe("whole_agent_run_private");
  expect(ledger.readStudy(ref).closure).toBeNull();
  expect(ledger.reserveStudyAttempt(ref, manifest.schedule[1]!.slot).slot.repetition).toBe(2);
  expect(readFileSync(join(root, "src/platform.ts"), "utf8")).toBe("export const protocol = 1;\n");
});

test("undeclared and out-of-order slots are refused without consuming scheduled work", () => {
  const { ledger, manifest } = fixture(); const ref = ledger.registerStudy(manifest);
  expect(() => ledger.reserveStudyAttempt(ref, { ...manifest.schedule[0]!.slot, repetition: 999 })).toThrow(/declared|schedule/i);
  expect(() => ledger.reserveStudyAttempt(ref, manifest.schedule[1]!.slot)).toThrow(/order|preced/i);
  expect(ledger.readStudy(ref).attempts).toHaveLength(0);
  expect(ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot).slot.repetition).toBe(1);
});

test("optional replication is inactive until an immutable whole-block activation, never a selected subset", () => {
  const { ledger, manifest } = fixture();
  manifest.optional_blocks = [{ id: "whole-repeat", slots: manifest.schedule.slice(2).map(entry => entry.slot), activation_rule: "operator_after_primary_before_optional" }];
  for (const entry of manifest.schedule.slice(2)) entry.optional_block = "whole-repeat";
  const ref = ledger.registerStudy(manifest);
  for (const entry of manifest.schedule.slice(0, 2)) settle(ledger, ledger.reserveStudyAttempt(ref, entry.slot));
  expect(ledger.readStudy(ref).slots.slice(2).map(entry => entry.status)).toEqual(["inactive", "inactive"]);
  expect(() => ledger.reserveStudyAttempt(ref, manifest.schedule[2]!.slot)).toThrow(/inactive|optional|activat/i);
  expect(() => ledger.activateStudyBlock(ref, { block_id: "undeclared", reason: "select favorable outcome" })).toThrow(/declared|block/i);
  const partial = { block_id: "whole-repeat", reason: "partial selection", slots: [manifest.schedule[2]!.slot] };
  expect(() => ledger.activateStudyBlock(ref, partial)).toThrow(/whole|partial|slot/i);
  ledger.activateStudyBlock(ref, { block_id: "whole-repeat", reason: "Preregistered full replication" });
  expect(ledger.readStudy(ref).slots.slice(2).map(entry => entry.status)).toEqual(["scheduled", "scheduled"]);
  expect(() => ledger.activateStudyBlock(ref, { block_id: "whole-repeat", reason: "rewrite disposition" })).toThrow(/immutable|activated|disposition/i);
  settle(ledger, ledger.reserveStudyAttempt(ref, manifest.schedule[2]!.slot));
  expect(ledger.reserveStudyAttempt(ref, manifest.schedule[3]!.slot).slot.repetition).toBe(4);
});

test("an optional block can be declined once and cannot be activated after seeing its disposition", () => {
  const { ledger, manifest } = fixture();
  manifest.optional_blocks = [{ id: "repeat", slots: manifest.schedule.slice(2).map(entry => entry.slot), activation_rule: "operator_after_primary_before_optional" }];
  for (const entry of manifest.schedule.slice(2)) entry.optional_block = "repeat";
  const ref = ledger.registerStudy(manifest);
  for (const entry of manifest.schedule.slice(0, 2)) settle(ledger, ledger.reserveStudyAttempt(ref, entry.slot));
  ledger.declineStudyBlock(ref, { block_id: "repeat", reason: "No full optional replication" });
  expect(ledger.readStudy(ref).slots.slice(2).map(entry => entry.status)).toEqual(["not_activated", "not_activated"]);
  expect(() => ledger.activateStudyBlock(ref, { block_id: "repeat", reason: "change mind" })).toThrow(/immutable|disposition|declined/i);
});

for (const invalid of [0, -1, 0.5, Infinity, NaN]) {
  test(`nonfinite or nonpositive allocation ${invalid} is refused`, () => {
    const { ledger, manifest } = fixture();
    for (const scope of ["per_attempt", "cohort"] as const) {
      for (const field of Object.keys(manifest.allowances[scope])) {
        const altered = structuredClone(manifest);
        Object.assign(altered.allowances[scope], { [field]: invalid });
        expect(() => ledger.registerStudy(altered)).toThrow(/finite|positive|integer/i);
      }
    }
  });
}

test("registration cannot promise scheduled allocations exceeding cohort request or summed wall totals", () => {
  const { ledger, manifest } = fixture();
  for (const field of ["host_requests", "attempt_wall_ms"] as const) {
    const altered = structuredClone(manifest); altered.allowances.cohort[field] = 1;
    expect(() => ledger.registerStudy(altered)).toThrow(/cohort|total|allocation/i);
  }
  const badConcurrency = structuredClone(manifest); badConcurrency.allowances.per_attempt.concurrent_requests = 2;
  expect(() => ledger.registerStudy(badConcurrency)).toThrow(/concurr|cohort|allocation/i);
});

test("an abandoned owner retains worker allocation across process restart; outcome alone does not certify drain", async () => {
  const { root, governance, ledger, manifest } = fixture(); const ref = ledger.registerStudy(manifest);
  const reservation = await child(`import { StudyLedger } from ${JSON.stringify(studyModule)};
    const ledger = new StudyLedger(${JSON.stringify(governance)}, {projectRoot:${JSON.stringify(root)}});
    console.log(JSON.stringify(ledger.reserveStudyAttempt(${JSON.stringify(ref)},${JSON.stringify(manifest.schedule[0]!.slot)}))); ledger.close();`);
  const restarted = reopen(governance, root);
  expect(() => restarted.reserveStudyAttempt(ref, manifest.schedule[1]!.slot)).toThrow(/worker|ownership|drain|concurr/i);
  restarted.settleStudyAttempt(reservation, { outcome: admissionOnlyOutcome, usage: null, evidence: [], stop_reason: null });
  expect(() => restarted.reserveStudyAttempt(ref, manifest.schedule[1]!.slot)).toThrow(/worker|ownership|drain|concurr/i);
  expect(() => restarted.confirmStudyResourceDrain(reservation, { requests_drained: false, runtime_closed: true, native_closed: true, evidence: [] })).toThrow(/drain|confirm|resource/i);
  drain(restarted, reservation);
  expect(restarted.reserveStudyAttempt(ref, manifest.schedule[1]!.slot).slot.repetition).toBe(2);
});

test("durable strategic admission denies transport before per-attempt requests exceed the frozen allowance", () => {
  const { ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  let transportCalls = 0;
  function transport(requestId: string) {
    const request = ledger.reserveStudyRequest(reservation, { requestId, path: "strategic" });
    transportCalls++;
    ledger.settleStudyRequest(request, { status: "settled", evidence: ["local synthetic transport returned"] });
  }
  transport("one"); transport("two");
  expect(() => transport("three")).toThrow(/request|allowance|limit/i);
  expect(transportCalls).toBe(2);
  expect(ledger.readStudy(ref).attempts[0]!.requests).toHaveLength(2);
  expect(() => transport("one")).toThrow(/duplicate|request|allowance|consumed/i);
});

test("undeclared Jev and postprocessing model paths are refused before synthetic transport", () => {
  const { ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot); let calls = 0;
  for (const path of ["jev", "offline_postprocessing"] as const) {
    expect(() => { ledger.reserveStudyRequest(reservation, { requestId: path, path }); calls++; }).toThrow(/path|declared|unsupported/i);
  }
  expect(calls).toBe(0);
});

test("unknown request ownership is not released by request settlement, process death or a claimed drain", () => {
  const { root, governance, ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const request = ledger.reserveStudyRequest(reservation, { requestId: "unknown", path: "strategic" });
  ledger.settleStudyRequest(request, { status: "unknown", evidence: ["transport ownership unconfirmed"] });
  const restarted = reopen(governance, root);
  expect(() => restarted.reserveStudyRequest(reservation, { requestId: "next", path: "strategic" })).toThrow(/concurr|ownership|unresolved/i);
  expect(() => drain(restarted, reservation)).toThrow(/request|ownership|unresolved|drain/i);
  expect(restarted.readStudy(ref).attempts[0]!.requests[0]).toMatchObject({ state: "unknown" });
});

test("two processes cannot overbook the same durable request-concurrency allocation", async () => {
  const { root, governance, ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const outcomes = await Promise.all(["a", "b"].map(requestId => child(`
    import {StudyLedger} from ${JSON.stringify(studyModule)};
    const ledger=new StudyLedger(${JSON.stringify(governance)},{projectRoot:${JSON.stringify(root)}});
    try { ledger.reserveStudyRequest(${JSON.stringify(reservation)},{requestId:${JSON.stringify(requestId)},path:"strategic"}); console.log(JSON.stringify({admitted:true})); }
    catch(error) {if(!/concurr|ownership|limit/i.test(String(error)))throw error; console.log(JSON.stringify({admitted:false}));} finally{ledger.close();}`)));
  expect(outcomes.filter(outcome => outcome.admitted)).toHaveLength(1);
  expect(ledger.readStudy(ref).attempts[0]!.requests).toHaveLength(1);
});

test("request concurrency belongs to the cohort as well as each independent worker", () => {
  const { ledger, manifest } = fixture(true);
  manifest.allowances.cohort.workers = 2;
  const ref = ledger.registerStudy(manifest);
  const first = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const second = ledger.reserveStudyAttempt(ref, manifest.schedule[1]!.slot);
  const request = ledger.reserveStudyRequest(first, { requestId: "first-owner", path: "strategic" });
  let calls = 0;
  expect(() => { ledger.reserveStudyRequest(second, { requestId: "second-owner", path: "strategic" }); calls++; }).toThrow(/cohort|concurr|ownership/i);
  expect(calls).toBe(0);
  ledger.settleStudyRequest(request, { status: "settled", evidence: ["local transport joined"] });
  expect(ledger.reserveStudyRequest(second, { requestId: "second-owner", path: "strategic" })).toMatchObject({ reservationId: second.reservationId });
});

test("a forged reservation cannot spend another slot's authority or rewrite its terminal outcome", () => {
  const { ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const forged = { ...reservation, slot: manifest.schedule[1]!.slot };
  expect(() => ledger.reserveStudyRequest(forged, { requestId: "stolen", path: "strategic" })).toThrow(/identity|reservation|slot|mismatch/i);
  expect(() => ledger.settleStudyAttempt(forged, { outcome: failedStudyOutcome, usage: null, evidence: [], stop_reason: null })).toThrow(/identity|reservation|slot|mismatch/i);
  expect(ledger.readStudy(ref).attempts[0]).toMatchObject({ state: "reserved", settlement: null, requests: [] });
});

test("attempt wall expiry denies requests while the separately durable elapsed cohort deadline closes new slots", () => {
  const { root, governance, manifest } = fixture(true);
  let now = 1_800_000_000_000;
  const ledger = new StudyLedger(governance, { projectRoot: root, now: () => now }); ledgers.push(ledger);
  const ref = ledger.registerStudy(manifest), reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  now += 1001;
  expect(() => ledger.reserveStudyRequest(reservation, { requestId: "late", path: "strategic" })).toThrow(/wall|deadline|expired/i);
  ledger.settleStudyAttempt(reservation, { outcome: failedStudyOutcome, usage: null, evidence: [], stop_reason: null }); drain(ledger, reservation);
  now += 60_000;
  expect(() => ledger.reserveStudyAttempt(ref, manifest.schedule[1]!.slot)).toThrow(/deadline|elapsed|closed/i);
  expect(ledger.readStudy(ref).closure).toMatchObject({ reason: "elapsed_deadline" });
});

for (const stop_reason of ["safety", "authority", "evaluation_leakage", "invalid_platform"] as const) {
  test(`${stop_reason} closes admissions durably while retaining every unfilled scheduled disposition`, () => {
    const { root, governance, ledger, manifest } = fixture(); const ref = ledger.registerStudy(manifest);
    const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
    ledger.settleStudyAttempt(reservation, { outcome: { ...admissionOnlyOutcome, platform_status: "fail" }, usage: null, evidence: ["local stop fixture"], stop_reason }); drain(ledger, reservation);
    const restarted = reopen(governance, root);
    expect(() => restarted.reserveStudyAttempt(ref, manifest.schedule[1]!.slot)).toThrow(/closed|stop/i);
    expect(restarted.readStudy(ref).closure).toMatchObject({ reason: stop_reason });
    expect(restarted.readStudy(ref).slots.slice(1).map(entry => entry.status)).toEqual(["closed_unstarted", "closed_unstarted", "closed_unstarted"]);
  });
}

test("early interruption is immutable and later cleanup confirmation cannot turn it into normal settlement", () => {
  const { root, governance, ledger, manifest } = fixture(); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  ledger.interruptStudyAttempt(reservation, "operator_interrupt");
  const restarted = reopen(governance, root);
  expect(() => restarted.settleStudyAttempt(reservation, { outcome: admissionOnlyOutcome, usage: null, evidence: [], stop_reason: null })).toThrow(/immutable|interrupted|reserved/i);
  drain(restarted, reservation);
  expect(restarted.readStudy(ref).attempts[0]).toMatchObject({ state: "interrupted", settlement: null, interruption: "operator_interrupt", cleanup: { confirmed: true } });
  expect(() => restarted.reserveStudyAttempt(ref, manifest.schedule[1]!.slot)).toThrow(/closed|interrupt/i);
});

test("private study authority uses the existing database rather than output-local storage", () => {
  const { governance, ledger, manifest } = fixture(); ledger.registerStudy(manifest);
  expect(statSync(governance).mode & 0o777).toBe(0o700);
  expect(statSync(join(governance, "attempts.sqlite")).mode & 0o777).toBe(0o600);
});

test("governance close releases every prepared transaction statement before returning, without waiting for GC", () => {
  const { root, governance, ledger, manifest } = fixture();
  const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  ledger.interruptStudyAttempt(reservation, "operator_interrupt");
  ledger.readStudy(ref);
  const diagnostics = new AttemptLedger(governance, { projectRoot: root });
  ledger.close();
  diagnostics.close();
  // Both JS owners remain strongly referenced here. A deferred close_v2 would
  // retain WAL writers until prepared transaction statements are collected.
  expect(existsSync(join(governance, "attempts.sqlite-wal"))).toBe(false);
  expect(existsSync(join(governance, "attempts.sqlite-shm"))).toBe(false);
});

test("fixed governance statements beyond Bun's built-in cache remain owned and finalized synchronously", () => {
  const { governance, ledger } = fixture(); ledger.close();
  const database = openGovernanceDatabase(governance);
  database.exec("CREATE TABLE ownership_marker (value INTEGER)");
  const retained: Array<{ get(): unknown }> = [];
  try {
    for (let value = 0; value <= Database.MAX_QUERY_CACHE_SIZE; value++) {
      const statement = database.query<{ value: number }, []>(`SELECT ${value} AS value`);
      expect(statement.get()?.value).toBe(value);
      retained.push(statement);
    }
  } finally { database.close(); }
  // Strong references deliberately outlive close. Neither cache overflow nor
  // a later collection may retain a writer or postpone its WAL checkpoint.
  for (const statement of retained) expect(() => statement.get()).toThrow();
  expect(existsSync(join(governance, "attempts.sqlite-wal"))).toBe(false);
  expect(existsSync(join(governance, "attempts.sqlite-shm"))).toBe(false);
});

test("study usage includes outcomes after a success and never zero-fills an unresolved attempt", () => {
  const { ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const first = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  ledger.settleStudyAttempt(first, { outcome: { ...failedStudyOutcome, agent_status: "goal_verified", goal_verified: true },
    usage: usageMetrics({ admissions: 0, admitted_request_ids: [], messages: [], events_omitted: false }), evidence: [], stop_reason: null }); drain(ledger, first);
  const second = ledger.reserveStudyAttempt(ref, manifest.schedule[1]!.slot);
  ledger.settleStudyAttempt(second, { outcome: failedStudyOutcome, usage: null, evidence: [], stop_reason: null }); drain(ledger, second);
  ledger.reserveStudyAttempt(ref, manifest.schedule[2]!.slot);
  expect(summarizeStudyUsage(ledger.readStudy(ref))).toMatchObject({
    scope: "all_reserved_study_outcomes", scheduled_slots: 4, attempts_included: 3,
    unsuccessful_or_unknown_attempts: 2, unresolved_or_interrupted_attempts: 1,
    admissions: null, durable_host_request_admissions: 0,
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 },
    wire_attempts: null, subscription_cost: null,
  });
});

test("an unchanged verified-success classifier outcome with no failure reasons settles normally", () => {
  const { ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const outcome = classifyEvaluation({ inferenceAdmitted: true, goalVerified: true, platformChecksComplete: true,
    providerError: false, providerSettled: true });
  ledger.settleStudyAttempt(reservation, { outcome, usage: null, evidence: [], stop_reason: null });
  expect(ledger.readStudy(ref).attempts[0]).toMatchObject({ state: "settled", settlement: { outcome } });
  expect(ledger.readStudy(ref).attempts[0]!.settlement!.outcome.classification_reason).toEqual([]);
});

test("confirmed actual request drain releases concurrency without rewriting unknown terminal consumption or refunding admission", () => {
  const { ledger, manifest } = fixture(true); const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  const first = ledger.reserveStudyRequest(reservation, { requestId: "unknown-consumption", path: "strategic" });
  ledger.settleStudyRequest(first, { status: "unknown", evidence: ["terminal usage and ownership were initially unconfirmed"] });
  expect(() => ledger.reserveStudyRequest(reservation, { requestId: "after-drain", path: "strategic" })).toThrow(/concurr|ownership|unresolved/i);
  ledger.confirmStudyRequestDrain(first, ["actual owner explicitly joined the transport"]);
  const second = ledger.reserveStudyRequest(reservation, { requestId: "after-drain", path: "strategic" });
  ledger.settleStudyRequest(second, { status: "settled", evidence: ["actual second transport returned"] });
  expect(ledger.readStudy(ref).attempts[0]!.requests.map(request => request.state)).toEqual(["unknown", "settled"]);
  expect(() => ledger.reserveStudyRequest(reservation, { requestId: "third", path: "strategic" })).toThrow(/allowance|request|limit/i);
});
