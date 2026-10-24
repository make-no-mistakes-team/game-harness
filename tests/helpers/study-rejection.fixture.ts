import { mock, spyOn } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { invalidStudyProfiles, writeStudyProfile } from "./study-manifest.ts";
import { studyExecutionFixture } from "./study-execution-fixture.ts";
import type { IsolatedStudyCheckout } from "./isolated-study-checkout.ts";
import * as native from "../../src/evaluation/native-game.ts";
import { StudyLedger } from "../../src/evaluation/studies.ts";
import { Database } from "bun:sqlite";

const [entry, mode, root, ownershipArg] = process.argv.slice(2);
if (!root) throw new Error("Missing disposable study project");
const calls: string[] = [];
const refuseExternal = (boundary: string): never => { calls.push(boundary); throw new Error(`Forbidden external boundary: ${boundary}`); };
mock.module(resolve(import.meta.dir, "../../src/server/auth.ts"), () => ({ AuthManager: { create: async () => refuseExternal("auth_discovery") } }));
mock.module(resolve(import.meta.dir, "../../src/evaluation/native-game.ts"), () => ({ ...native, NativeFixture: { create: async () => refuseExternal("native_fixture") } }));
spyOn(Bun, "spawn").mockImplementation(() => refuseExternal("child_process"));
const isolatedCheckout: IsolatedStudyCheckout | undefined = JSON.parse(ownershipArg ?? "null");
const execution = studyExecutionFixture(mode !== "admission-flags", undefined, { isolatedCheckout });
const manifest = execution.manifest, projectRoot = execution.projectRoot;
const invalidProfile = invalidStudyProfiles().find(profile => profile.name === mode);
if (invalidProfile) writeStudyProfile(projectRoot, manifest, invalidProfile.profile);
const manifestPath = execution.manifestPath, governanceRoot = join(root, "governance");
const ledger = new StudyLedger(governanceRoot, { projectRoot });
let ref;
let registrationError: string | null = null;
try { ref = ledger.registerStudy(manifest); }
catch (error) {
  if (!invalidProfile) throw error;
  registrationError = error instanceof Error ? error.message : String(error);
} finally { ledger.close(); }
if (mode === "source-mismatch") writeFileSync(join(execution.fixtureRoot, "src/platform.ts"), "changed declared fixture source after registration\n");
if (mode === "manifest-mismatch") manifest.analysis.rule = "rewrite analysis after registration";
writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
const selection = { studyId: manifest.study_id, manifestPath, slot: manifest.schedule[0]!.slot };
const flags = ["--study", manifest.study_id, "--manifest", manifestPath, "--slot", JSON.stringify(selection.slot)];
if (mode !== "missing-opt-ins") flags.push("--allow-native", "--allow-inference");
if (mode === "admission-flags") flags.push("--admission-only");
if (mode === "override-model") flags.push("--model", "not-the-frozen-model");
if (mode === "override-budget") flags.push("--max-requests", "999");
if (mode === "lower-request-budget") flags.push("--max-requests", "1");
if (mode === "missing-manifest") flags.splice(flags.indexOf("--manifest"), 2);
flags.push("--auth-dir", join(root, "absent-auth-must-not-be-inspected"));
process.env.GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT = governanceRoot;
process.env.GAMEHARNESS_EVALUATION_REPORTS_ROOT = join(root, "reports");
process.env.GAMEHARNESS_EVALUATION_RUNTIME_ROOT = join(root, "runtime");
let error: string | null = null;
try {
  // Intentional loading boundary: external sentinels must be installed before
  // either production entry imports auth/native modules.
  if (entry === "dispatcher") {
    const { runEvaluation } = await import("../../scripts/evaluate.ts");
    await runEvaluation(["study", ...flags]);
  } else {
    const { runAgentAcceptance, parseAgentAcceptanceArguments } = await import("../../scripts/agent-acceptance.ts");
    const options = parseAgentAcceptanceArguments(flags);
    await runAgentAcceptance(options);
  }
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
const read = new StudyLedger(governanceRoot, { projectRoot });
const database = new Database(join(governanceRoot, "attempts.sqlite"), { readonly: true });
const count = database.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM study_attempts");
try { console.log(JSON.stringify({ error, registrationError, externalCalls: calls, study: ref ? read.readStudy(ref) : null,
  reservedAttemptCount: count.get()!.count })); }
finally { count.finalize(); database.close(true); read.close(); rmSync(execution.caseRoot, { recursive: true, force: true }); }
