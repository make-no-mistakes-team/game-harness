import { mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StudyLedger } from "../../src/evaluation/studies.ts";
import * as native from "../../src/evaluation/native-game.ts";

const [entry, executingRoot, declaredRoot, manifestPath, caseRoot, rootSelection] = process.argv.slice(2);
if (!entry || !executingRoot || !declaredRoot || !manifestPath || !caseRoot) throw new Error("Missing isolated checkout binding fixture selection");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const governanceRoot = join(caseRoot, "governance");
const calls: { boundary: string; reservationSeen: boolean }[] = [];
const ledger = new StudyLedger(governanceRoot, { projectRoot: declaredRoot });
let ref;
try { ref = ledger.registerStudy(manifest); } finally { ledger.close(); }
const external = (boundary: string): never => {
  const inspect = new StudyLedger(governanceRoot, { projectRoot: declaredRoot });
  try { calls.push({ boundary, reservationSeen: inspect.readStudy(ref).attempts.length === 1 }); }
  finally { inspect.close(); }
  throw new Error("External fixture boundary deliberately unavailable; no game or provider starts");
};
mock.module(resolve(executingRoot, "src/server/auth.ts"), () => ({ AuthManager: { create: async () => external("auth_discovery") } }));
mock.module(resolve(executingRoot, "src/evaluation/native-game.ts"), () => ({ ...native,
  NativeFixture: { create: async () => external("native_fixture") } }));
const authDirectory = join(caseRoot, "synthetic-auth-seam");
mkdirSync(join(authDirectory, "auth"), { recursive: true, mode: 0o700 });
writeFileSync(join(authDirectory, "auth/gameharness.sqlite"), "Local seam marker; never credential storage or opened by an auth factory", { mode: 0o600 });
process.env.GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT = governanceRoot;
process.env.GAMEHARNESS_EVALUATION_RUNTIME_ROOT = join(caseRoot, "runtime");
process.env.GAMEHARNESS_EVALUATION_REPORTS_ROOT = join(caseRoot, "reports");
const args = ["--study", manifest.study_id, "--manifest", manifestPath, "--slot", JSON.stringify(manifest.schedule[0].slot),
  "--allow-native", "--allow-inference", "--auth-dir", authDirectory];
let error: string | null = null;
try {
  // Intentionally load the selected executing checkout only after installing
  // its native/auth sentinels. This does not mock its admission or source check.
  if (entry === "dispatcher") {
    const module = await import(resolve(executingRoot, "scripts/evaluate.ts"));
    if (rootSelection === "override") await module.runEvaluation(["study", ...args], declaredRoot);
    else await module.runEvaluation(["study", ...args]);
  } else {
    const module = await import(resolve(executingRoot, "scripts/agent-acceptance.ts"));
    const options = module.parseAgentAcceptanceArguments(args);
    await module.runAgentAcceptance(rootSelection === "override" ? { ...options, projectRoot: declaredRoot } : options);
  }
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
const inspect = new StudyLedger(governanceRoot, { projectRoot: declaredRoot });
try { console.log(JSON.stringify({ error, externalCalls: calls, study: inspect.readStudy(ref),
  runtimeCreated: existsSync(join(caseRoot, "runtime")), reportsCreated: existsSync(join(caseRoot, "reports")) })); }
finally { inspect.close(); }
