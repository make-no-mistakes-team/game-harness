import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AttemptLedger } from "../src/evaluation/policy.ts";
import { evaluationPaths } from "../src/evaluation/paths.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import type { PlatformEvidenceKind, VerificationTier } from "../src/evaluation/contracts.ts";
import { runCheck } from "./check.ts";

function takeValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`Provide ${name} <value>`);
  const value = args[index + 1]!;
  args.splice(index, 2);
  return value;
}

export async function runEvaluation(input: readonly string[], projectRoot = fileURLToPath(new URL("..", import.meta.url))): Promise<number> {
  const args = input.filter(argument => argument !== "--");
  const tier = args.shift();
  if (!tier || tier === "--help" || tier === "help") {
    console.log(`Verification tiers:
  bun run evaluate unit [test-file ...]
  bun run evaluate integration [test-file ...]
  bun run evaluate native-game --allow-native --jar <fresh-built.jar>
  bun run evaluate agent-acceptance --allow-native --allow-inference --jar <fresh-built.jar> --auth-dir <existing-private-auth-root> --hypothesis <stable-id> --evidence-revision <revision> [acceptance options]
New platform evidence (never a model/prompt-only reset):
  bun run evaluate authorize-evidence --hypothesis <stable-id> --evidence-revision <new-id> --reason <concrete-reason> --reference <source|schema|native_artifact|repro>:<file> [...]
No tier automatically runs Gradle/Vite. Native commands stop on stale artifacts. Agent acceptance consumes real provider allowance only after durable reservation.`);
    return 0;
  }
  if (tier === "unit" || tier === "integration") return await runCheck([tier, ...args], projectRoot);
  if (tier === "authorize-evidence") {
    const hypothesisId = takeValue(args, "--hypothesis");
    const revision = takeValue(args, "--evidence-revision");
    const reason = takeValue(args, "--reason");
    const references: { kind: PlatformEvidenceKind; path: string }[] = [];
    while (args.includes("--reference")) {
      const reference = takeValue(args, "--reference");
      const colon = reference.indexOf(":");
      const kind = reference.slice(0, colon);
      if (colon < 1 || !["source", "schema", "native_artifact", "repro"].includes(kind))
        throw new Error("Reference must be source|schema|native_artifact|repro:<real-file>");
      references.push({ kind: kind as PlatformEvidenceKind, path: reference.slice(colon + 1) });
    }
    if (args.length) throw new Error(`Unexpected evidence arguments: ${args.join(" ")}`);
    const ledger = new AttemptLedger(evaluationPaths(projectRoot).governanceRoot, { projectRoot });
    try { ledger.authorizePlatformEvidence(hypothesisId, { revision, reason, references }); }
    finally { ledger.close(); }
    console.log("New concrete platform evidence authorized; all previous attempts and failures retained.");
    return 0;
  }
  if (tier !== "native-game" && tier !== "agent-acceptance") throw new Error("Choose unit, integration, native-game or agent-acceptance");
  requireTierOptIn(tier satisfies VerificationTier, { allowNative: args.includes("--allow-native"), allowInference: args.includes("--allow-inference") });
  const artifact = assertNativeArtifactFresh(projectRoot, takeValue(args, "--jar"));
  const script = tier === "native-game" ? "scripts/native-game.ts" : "scripts/agent-acceptance.ts";
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve(projectRoot, script), ...args], {
    cwd: projectRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, GAMEHARNESS_NATIVE_PROOF: "1", GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256: artifact.sha256 },
  });
  return await child.exited;
}

if (import.meta.main) {
  try { process.exitCode = await runEvaluation(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
