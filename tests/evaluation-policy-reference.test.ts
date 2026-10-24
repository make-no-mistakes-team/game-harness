import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyLedger, validateStudyManifest, type StudyManifest } from "../src/evaluation/studies.ts";
import { referenceStudyFixture } from "./helpers/reference-study.ts";
import { liveStudyManifest } from "./helpers/study-manifest.ts";
import { referenceExecutionFixture } from "./helpers/reference-execution-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gh-reference-study-")); roots.push(root);
  return { root, ...referenceStudyFixture(root) };
}

const negative = {
  outcome: { platform_status: "pass" as const, agent_status: "goal_not_verified" as const, provider_status: "not_called" as const,
    goal_verified: false, classification_reason: ["Synthetic completed negative reference result; no model/game executed"] },
  usage: null, evidence: ["synthetic-reference-result.json"], stop_reason: null,
};

test("the original-reference variant registers actual pinned fixture files with zero provider allowance", () => {
  const { root, manifest } = fixture();
  const checked = validateStudyManifest(manifest, { projectRoot: root });
  expect(checked.identities.observation_schema).toBe(1);
  expect(checked.identities.game!.version).toBe("1.16.5");
  expect(checked.identities.model).toBeNull();
  expect(checked.execution.request_paths).toEqual([]);
  expect(checked.allowances.per_attempt.host_requests).toBe(0);
  expect(checked.initial_states[0]!.mode).toBe("declared_reference_fixture");
  expect(Object.isFrozen(checked)).toBe(true);
});

test("ordinary negative reference results persist without fabricating provider calls or confirmed drain", () => {
  const { root, manifest } = fixture(), storage = join(root, "governance");
  let ledger = new StudyLedger(storage, { projectRoot: root });
  const ref = ledger.registerStudy(manifest);
  const reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
  expect(() => ledger.reserveStudyRequest(reservation, { requestId: "forbidden-provider", path: "strategic" })).toThrow(/undeclared|unsupported/i);
  ledger.settleStudyAttempt(reservation, negative);
  ledger.close();
  ledger = new StudyLedger(storage, { projectRoot: root });
  try {
    const state = ledger.readStudy(ref);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]!.settlement!.outcome.goal_verified).toBe(false);
    expect(state.attempts[0]!.settlement!.outcome.provider_status).toBe("not_called");
    expect(state.attempts[0]!.requests).toEqual([]);
    expect(state.attempts[0]!.cleanup.confirmed).toBe(false);
    expect(() => ledger.confirmStudyResourceDrain(reservation, { requests_drained: true, runtime_closed: true, native_closed: false, evidence: ["not closed"] })).toThrow();
    expect(() => ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot)).toThrow(/duplicate|reserved|consumed/i);
    ledger.confirmStudyResourceDrain(reservation, { requests_drained: true, runtime_closed: true, native_closed: true, evidence: ["synthetic owners actually closed"] });
    expect(ledger.readStudy(ref).attempts[0]!.settlement!.outcome.goal_verified).toBe(false);
    expect(ledger.readStudy(ref).attempts[0]!.cleanup.confirmed).toBe(true);
  } finally { ledger.close(); }
});

test("reference setup failures remain consumed while provider success claims are refused", () => {
  const { root, manifest } = fixture();
  const ledger = new StudyLedger(join(root, "governance"), { projectRoot: root });
  try {
    const ref = ledger.registerStudy(manifest), reservation = ledger.reserveStudyAttempt(ref, manifest.schedule[0]!.slot);
    expect(() => ledger.settleStudyAttempt(reservation, { ...negative, outcome: { ...negative.outcome, provider_status: "ok" } })).toThrow(/provider|reference/i);
    ledger.settleStudyAttempt(reservation, { ...negative, outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called",
      goal_verified: null, classification_reason: ["Synthetic missing artifact before model/game execution"] }, stop_reason: "invalid_platform" });
    const state = ledger.readStudy(ref);
    expect(state.attempts[0]!.state).toBe("settled");
    expect(state.attempts[0]!.cleanup.confirmed).toBe(false);
    expect(state.closure!.reason).toBe("invalid_platform");
  } finally { ledger.close(); }
});

test("fixture byte tampering closes registered reference admission instead of silently refreshing identity", () => {
  const { root, manifest, fixtures } = fixture();
  const ledger = new StudyLedger(join(root, "governance"), { projectRoot: root });
  try {
    const ref = ledger.registerStudy(manifest);
    writeFileSync(join(root, fixtures[0]!.path), "different fixture bytes");
    expect(() => ledger.validateRegisteredStudy(ref)).toThrow(/fixture|hash/i);
    expect(ledger.readStudy(ref).closure!.reason).toBe("source_or_reference_identity_mismatch");
    expect(ledger.readStudy(ref).attempts).toEqual([]);
  } finally { ledger.close(); }
});

const invalid: { name: string; change(value: StudyManifest): void }[] = [
  { name: "provider path", change: value => { value.execution.request_paths = ["strategic"]; } },
  { name: "provider allowance", change: value => { value.allowances.per_attempt.host_requests = 1; value.allowances.cohort.host_requests = 1; } },
  { name: "provider identity", change: value => { value.identities.model = { provider: "synthetic", id: "not-a-real-model", api: "none", access: "none" }; } },
  { name: "native descriptor schema", change: value => { value.identities.observation_schema = 3; } },
  { name: "native game substitution", change: value => { value.identities.game!.version = "1.21.4"; } },
  { name: "prepared-save equivalence", change: value => { value.execution.start_mode = "prepared_save"; } },
  { name: "missing controller", change: value => { value.identities.controller = null; } },
  { name: "extra repetition", change: value => { value.repetitions = 2; } },
];
for (const { name, change } of invalid) test(`reference declaration refuses ${name}`, () => {
  const { root, manifest } = fixture(); change(manifest);
  expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow();
});

test("whole-agent live studies still require positive provider allocations and an actual model", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-whole-agent-reference-regression-")); roots.push(root);
  const manifest = liveStudyManifest(root);
  for (const field of ["host_requests", "concurrent_requests"] as const) {
    const changed = structuredClone(manifest);
    changed.allowances.per_attempt[field] = 0;
    expect(() => validateStudyManifest(changed, { projectRoot: root })).toThrow(/positive|provider|request|allowance/i);
  }
  const changed = structuredClone(manifest); changed.identities.model = null;
  expect(() => validateStudyManifest(changed, { projectRoot: root })).toThrow(/model|identity/i);
});

test("dedicated CLI registers through the existing ledger and refuses a non-opted-in run before reservation", async () => {
  const { projectRoot, caseRoot: root, manifest, manifestPath: path, cli: entry, governanceRoot: governance } = referenceExecutionFixture();
  roots.push(root);
  const env = { ...process.env, GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: governance,
    GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(root, "runtime"), GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(root, "reports") };
  const registered = Bun.spawn([process.execPath, "--no-env-file", entry, "register", "--study-manifest", path], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(registered.stdout).text(), new Response(registered.stderr).text(), registered.exited]);
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  const ref = JSON.parse(output).study;
  const run = Bun.spawn([process.execPath, "--no-env-file", entry, "run", "--study-manifest", path], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [, runError, runCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(runCode).toBe(1);
  expect(runError).toContain("opt-ins");
  const ledger = new StudyLedger(governance, { projectRoot });
  try { expect(ledger.readStudy(ref).attempts).toEqual([]); } finally { ledger.close(); }
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(manifest));
});

test("actual reference CLI retains a missing-prerequisite setup attempt without starting Docker or a model", async () => {
  const { projectRoot, caseRoot: root, manifest, manifestPath: path, cli: entry, governanceRoot: governance, controllerPath, fixtureRoot } = referenceExecutionFixture();
  roots.push(root);
  const binaries = join(root, "sentinel-bin"), marker = join(root, "unexpected-native-command");
  mkdirSync(binaries);
  for (const command of ["docker", "nvidia-smi"])
    writeFileSync(join(binaries, command), `#!/bin/sh\nprintf unexpected > '${marker}'\nexit 77\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${binaries}:${process.env.PATH}`,
    GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: governance, GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(root, "runtime"),
    GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(root, "reports") };
  const registered = Bun.spawn([process.execPath, "--no-env-file", entry, "register", "--study-manifest", path], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [registeredOut, registeredError, registeredCode] = await Promise.all([new Response(registered.stdout).text(), new Response(registered.stderr).text(), registered.exited]);
  expect({ registeredCode, registeredError }).toEqual({ registeredCode: 0, registeredError: "" });
  const ref = JSON.parse(registeredOut).study;
  const output = join(root, "reference-output");
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "run", "--study", manifest.study_id, "--study-manifest", path,
    "--slot", JSON.stringify(manifest.schedule[0]!.slot), "--controller", controllerPath,
    "--prepared-root", join(root, "missing-prepared"), "--fixtures-root", join(fixtureRoot, "private"), "--output", output,
    "--allow-native", "--allow-inference"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 1, stderr: "" });
  const result = JSON.parse(stdout).result;
  expect(result.setup_status).toBe("failed");
  expect(result.reference_status).toBe("blocked");
  expect(result.actual.inferences).toBe(0);
  expect(result.actual.steps).toBe(0);
  expect(result.actual.provider_requests).toBe(0);
  expect(result.cleanup).toBe("confirmed");
  expect(existsSync(marker)).toBe(false);
  const ledger = new StudyLedger(governance, { projectRoot });
  try {
    const state = ledger.readStudy(ref);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]!.state).toBe("settled");
    expect(state.attempts[0]!.settlement!.outcome.provider_status).toBe("not_called");
    expect(state.attempts[0]!.cleanup.confirmed).toBe(true);
  } finally { ledger.close(); }
});

test("F3 executing checkout B cannot register checkout A's frozen inventory merely by running from A", async () => {
  const fixture = referenceExecutionFixture(); roots.push(fixture.caseRoot);
  const { projectRoot, manifestPath, cli, governanceRoot, caseRoot } = fixture;
  const env = { ...process.env, GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: governanceRoot,
    GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(caseRoot, "runtime"), GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(caseRoot, "reports") };
  const first = Bun.spawn([process.execPath, "--no-env-file", cli, "register", "--study-manifest", manifestPath],
    { cwd: projectRoot, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(first.stdout).text(), new Response(first.stderr).text(), first.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const ref = JSON.parse(stdout).study;
  const other = join(caseRoot, "executing-checkout-B"); mkdirSync(join(other, "scripts"), { recursive: true });
  symlinkSync(join(projectRoot, "src"), join(other, "src"), "dir");
  const secondCli = join(other, "scripts/policy-reference.ts");
  copyFileSync(cli, secondCli);
  writeFileSync(secondCli, `${readFileSync(secondCli, "utf8")}\n// Divergent executing entry identity; never a game fixture.\n`);
  const second = Bun.spawn([process.execPath, "--no-env-file", secondCli, "register", "--study-manifest", manifestPath],
    { cwd: projectRoot, env, stdout: "pipe", stderr: "pipe" });
  const [, failure, status] = await Promise.all([new Response(second.stdout).text(), new Response(second.stderr).text(), second.exited]);
  expect(status).toBe(1);
  expect(failure).toMatch(/source|identity|project|symlink|manifest|ENOENT/i);
  const ledger = new StudyLedger(governanceRoot, { projectRoot });
  try { expect(ledger.readStudy(ref).attempts).toEqual([]); } finally { ledger.close(); }
});

test("F8 fixed reference route rejects a shorter task horizon instead of ignoring it", () => {
  const { root, manifest } = fixture();
  manifest.task.horizon_ms = 1;
  expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow(/horizon|allocation/i);
});

test("F3 the exported CLI cannot authorize a foreign source tree through its projectRoot argument", async () => {
  const { root, manifest } = fixture();
  const manifestPath = join(root, "private/study.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const actualRoot = fileURLToPath(new URL("../", import.meta.url));
  const entry = join(actualRoot, "scripts/policy-reference.ts"), caller = join(root, "foreign-root-caller.ts");
  writeFileSync(caller, `import { runPolicyReference } from ${JSON.stringify(entry)};\n` +
    `try { await runPolicyReference(["register","--study-manifest",${JSON.stringify(manifestPath)}], ${JSON.stringify(root)}); }\n` +
    `catch (error) { console.error(String(error)); process.exitCode=1; }\n`);
  const env = { ...process.env, GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: join(root, "governance"),
    GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(root, "runtime"), GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(root, "reports") };
  const child = Bun.spawn([process.execPath, "--no-env-file", caller], { cwd: actualRoot, env, stdout: "pipe", stderr: "pipe" });
  const [, failure, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status).toBe(1);
  expect(failure).toMatch(/source|project|identity|ENOENT|manifest/i);
});
