import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StudyLedger } from "../src/evaluation/studies.ts";
import { studyExecutionFixture } from "./helpers/study-execution-fixture.ts";
import { isolatedStudyCheckout } from "./helpers/isolated-study-checkout.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function sourceBindingFixture(entry: string, executingRoot: string, declaredRoot: string, manifestPath: string, caseRoot: string, rootSelection: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "helpers/study-source-binding.fixture.ts"),
    entry, executingRoot, declaredRoot, manifestPath, caseRoot, rootSelection], {
    cwd: declaredRoot, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}
async function executionFixture(live = false) {
  if (!live) {
    const fixture = studyExecutionFixture(); roots.push(fixture.caseRoot);
    return fixture;
  }
  const owned = isolatedStudyCheckout(); roots.push(owned.caseRoot);
  // Runtime-selected real copied helper; its module URL binds the same copied
  // executing source tree that the production entry will validate.
  const module = await import(join(owned.projectRoot, "tests/helpers/study-execution-fixture.ts"));
  return module.studyExecutionFixture(true, undefined, { isolatedCheckout: owned });
}
async function fixture(live = false) {
  const fixture = await executionFixture(live);
  return { root: fixture.projectRoot, manifest: fixture.manifest, file: fixture.manifestPath, governance: fixture.governanceRoot };
}
async function cli(root: string, governance: string, args: string[], suffix = "first") {
  // The source root is the actual executing checkout. Only storage and
  // declaration files are private/disposable; no provenance override is used.
  const entry = `import { runEvaluation } from ${JSON.stringify(join(root, "scripts/evaluate.ts"))};
    try { process.exitCode = await runEvaluation(${JSON.stringify(args)}); }
    catch(error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", entry], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: governance,
      GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(dirname(governance), `reports-${suffix}`), GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(dirname(governance), `runtime-${suffix}`),
      GAMEHARNESS_DATA_DIR: join(dirname(governance), "must-not-create-auth-data") } });
  // Real process deadlock containment; assertions await the child's actual exit.
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); }
}

test("a smaller CLI study request cap is refused before reservation rather than accepted and silently ignored", async () => {
  const { root, file, manifest, governance } = await fixture(true);
  const registered = await cli(root, governance, ["register-study", "--manifest", file]);
  expect({ exit: registered.exit, stderr: registered.stderr }).toEqual({ exit: 0, stderr: "" });
  const ref = JSON.parse(registered.stdout).study;
  const result = await cli(root, governance, ["study", "--study", manifest.study_id, "--manifest", file,
    "--slot", JSON.stringify(manifest.schedule[0]!.slot), "--allow-native", "--allow-inference",
    "--auth-dir", join(root, "absent-auth-must-not-be-inspected"), "--max-requests", "1"]);
  expect(result.exit).not.toBe(0);
  const ledger = new StudyLedger(governance, { projectRoot: root });
  try {
    expect(ledger.readStudy(ref).attempts).toEqual([]);
    expect(ledger.readStudy(ref).closure).toBeNull();
  } finally { ledger.close(); }
}, 30_000);

test("actual evaluator registers, reserves and settles admission-only work in separate processes without fake gameplay", async () => {
  const { root, file, manifest, governance } = await fixture();
  const registered = await cli(root, governance, ["register-study", "--manifest", file]);
  expect({ exit: registered.exit, stderr: registered.stderr }).toEqual({ exit: 0, stderr: "" });
  const ref = JSON.parse(registered.stdout).study;
  expect(ref).toMatchObject({ studyId: manifest.study_id }); expect(ref.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  const slot = JSON.stringify(manifest.schedule[0]!.slot);
  const run = await cli(root, governance, ["study", "--study", manifest.study_id, "--manifest", file, "--slot", slot, "--admission-only"]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const report = JSON.parse(run.stdout);
  expect(report).toMatchObject({ study_id: manifest.study_id, slot: manifest.schedule[0]!.slot,
    outcome: { platform_status: "pass", agent_status: "not_run", provider_status: "not_called", goal_verified: null },
    usage: { admissions: 0, wire_attempts: null } });
  expect(report).not.toHaveProperty("hypothesis_id");
  const ledger = new StudyLedger(governance, { projectRoot: root });
  try {
    const state = ledger.readStudy(ref);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ reservationId: report.reservation_id, state: "settled", slot: manifest.schedule[0]!.slot,
      settlement: { outcome: { agent_status: "not_run", provider_status: "not_called", goal_verified: null } }, cleanup: { confirmed: true } });
  } finally { ledger.close(); }
  const duplicate = await cli(root, governance, ["study", "--study", manifest.study_id, "--manifest", file, "--slot", slot, "--admission-only"], "changed-output-directory");
  expect(duplicate.exit).not.toBe(0); expect(duplicate.stderr).toMatch(/reserved|duplicate|consumed/i);
  expect(readFileSync(file, "utf8")).toBe(JSON.stringify(manifest));
}, 30_000);

for (const resourceFlags of [["--allow-inference"], ["--allow-native"], ["--auth-dir", "must-not-open"], ["--jar", "must-not-launch.jar"]]) {
  test(`admission-only CLI refuses resource flags ${resourceFlags[0]} before consuming a slot`, async () => {
    const { root, file, manifest, governance } = await fixture();
    const registered = await cli(root, governance, ["register-study", "--manifest", file]);
    expect(registered.exit).toBe(0); const ref = JSON.parse(registered.stdout).study;
    const run = await cli(root, governance, ["study", "--study", manifest.study_id, "--manifest", file, "--slot", JSON.stringify(manifest.schedule[0]!.slot), "--admission-only", ...resourceFlags]);
    expect(run.exit).not.toBe(0); expect(run.stderr).toMatch(/admission.only|resource|incompatible|forbidden/i);
    const ledger = new StudyLedger(governance, { projectRoot: root });
    try { expect(ledger.readStudy(ref).attempts).toHaveLength(0); } finally { ledger.close(); }
  }, 30_000);
}

test("missing and mismatched manifests fail before native/auth discovery or slot reservation", async () => {
  const { root, file, manifest, governance } = await fixture();
  const registered = await cli(root, governance, ["register-study", "--manifest", file]);
  expect(registered.exit).toBe(0); const ref = JSON.parse(registered.stdout).study;
  const common = ["study", "--study", manifest.study_id, "--slot", JSON.stringify(manifest.schedule[0]!.slot), "--admission-only"];
  const missing = await cli(root, governance, common);
  expect(missing.exit).not.toBe(0); expect(missing.stderr).toMatch(/manifest/i);
  const altered = structuredClone(manifest); altered.analysis.rule = "changed analysis after declaration";
  writeFileSync(file, JSON.stringify(altered));
  const mismatch = await cli(root, governance, [...common, "--manifest", file]);
  expect(mismatch.exit).not.toBe(0); expect(mismatch.stderr).toMatch(/manifest|mismatch|immutable/i);
  const ledger = new StudyLedger(governance, { projectRoot: root });
  try { expect(ledger.readStudy(ref).attempts).toHaveLength(0); } finally { ledger.close(); }
}, 30_000);

for (const entry of ["dispatcher", "direct"]) {
  test(`${entry} live external-seam fixtures admit from an owned clean source checkout without a generated user JAR`, async () => {
    const owned = isolatedStudyCheckout(); roots.push(owned.caseRoot);
    const checkout = owned.projectRoot;
    expect(existsSync(join(checkout, "native/minecraft/build/libs/gameharness-native-1.0.0.jar"))).toBe(false);
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "helpers/clean-source-study.fixture.ts"), entry, checkout], {
      cwd: checkout, stdout: "pipe", stderr: "pipe",
    });
    // Real subprocess containment, not a guessed wait for resource closure.
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const before = stdout.split("\n").find(line => line.startsWith("CLEAN_SOURCE_STATE "));
      expect(before).toBeDefined();
      expect(JSON.parse(before!.slice("CLEAN_SOURCE_STATE ".length))).toEqual({ generatedJarInitiallyAbsent: true, projectRoot: checkout });
      const line = stdout.split("\n").find(line => line.startsWith("{"));
      expect(line).toBeDefined();
      const result = JSON.parse(line!);
      expect(result.externalCalls).toEqual([{ boundary: "native_fixture", reservationSeen: true }]);
      expect(result.study.attempts).toHaveLength(1);
      expect(result.study.attempts[0]).toMatchObject({ state: "settled", settlement: { stop_reason: "invalid_platform",
        outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called", goal_verified: null } } });
      expect(result.runtimeCreated).toBe(false);
      expect(result.reportsCreated).toBe(false);
    } finally { clearTimeout(timer); }
  }, 35_000);

  for (const rootSelection of ["cwd", "override"]) {
    test(`${entry} executing checkout B refuses checkout A's source claim from cwd A (${rootSelection}) before reservation or external preparation`, async () => {
      const fixture = await executionFixture(true);
      const other = join(fixture.caseRoot, "executing-checkout-B");
      mkdirSync(other);
      cpSync(join(fixture.projectRoot, "src"), join(other, "src"), { recursive: true });
      cpSync(join(fixture.projectRoot, "scripts"), join(other, "scripts"), { recursive: true });
      const divergentRuntime = join(other, "src/server/runtime.ts");
      writeFileSync(divergentRuntime, `${readFileSync(divergentRuntime, "utf8")}\nthrow new Error("Checkout B has different orchestration; it must not execute under checkout A provenance");\n`);
      expect(readFileSync(divergentRuntime, "utf8")).not.toBe(readFileSync(join(fixture.projectRoot, "src/server/runtime.ts"), "utf8"));
      expect(readFileSync(join(other, "src/server/minecraft-adapter.ts"), "utf8")).toBe(readFileSync(join(fixture.projectRoot, "src/server/minecraft-adapter.ts"), "utf8"));
      const result = await sourceBindingFixture(entry, other, fixture.projectRoot, fixture.manifestPath, fixture.caseRoot, rootSelection);
      expect(typeof result.error).toBe("string");
      expect(result.externalCalls).toEqual([]);
      expect(result.study.attempts).toEqual([]);
      expect(result.runtimeCreated).toBe(false);
      expect(result.reportsCreated).toBe(false);
    }, 30_000);
  }

  test(`${entry} admits a genuine executing-tree manifest held in private declaration storage with independent governance/runtime/report roots`, async () => {
    const fixture = await executionFixture(true);
    const result = await sourceBindingFixture(entry, fixture.projectRoot, fixture.projectRoot, fixture.manifestPath, fixture.caseRoot, "cwd");
    expect(result.externalCalls).toEqual([{ boundary: "native_fixture", reservationSeen: true }]);
    expect(result.study.attempts).toHaveLength(1);
    expect(result.study.attempts[0]).toMatchObject({ state: "settled", settlement: { stop_reason: "invalid_platform",
      outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called", goal_verified: null } } });
    expect(result.study.closure).toMatchObject({ reason: "invalid_platform" });
    expect(result.runtimeCreated).toBe(false);
    expect(result.reportsCreated).toBe(false);
  }, 30_000);
}
