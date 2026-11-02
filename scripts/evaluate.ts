import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { AttemptLedger } from "../src/evaluation/policy.ts";
import { evaluationPaths } from "../src/evaluation/paths.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import type { PlatformEvidenceKind, VerificationTier } from "../src/evaluation/contracts.ts";
import { runCheck } from "./check.ts";
import { StudyLedger, validateStudyManifest } from "../src/evaluation/studies.ts";
import { parseAgentAcceptanceArguments, runAgentAcceptance } from "./agent-acceptance.ts";

const COMMANDS = [
  ["unit", "[test-file ...]", "Pure/local classified checks"],
  ["integration", "[test-file ...]", "Classified integration seams, no real game/provider"],
  ["native-game", "--allow-native --jar <fresh-built.jar>", "Actual native planning/continuation baseline"],
  ["native-recording", "--allow-native --jar <fresh-built.jar> [--duration-ms <1000..1800000>] [--evidence-profile <private-profile.json>]", "Actual zero-inference recording proof"],
  ["agent-acceptance", "--allow-native --allow-inference --jar <fresh-built.jar> --auth-dir <existing-private-auth-root> --hypothesis <stable-id> --evidence-revision <revision> [--evidence-profile <private-profile.json>] [acceptance options]", "Diagnostic admission; historical two-unsuccessful rule"],
  ["register-study", "--manifest <private-study.json>", "Register a complete immutable finite declaration"],
  ["study", "--study <registered-id> --manifest <same-private-study.json> --slot '<JSON StudySlot>' [--admission-only | --allow-native --allow-inference --auth-dir <existing-private-auth-root> [--evidence-profile <frozen-private-profile.json>]]", "Reserve exactly one declared slot before external preparation"],
  ["authorize-evidence", "--hypothesis <id> --evidence-revision <new-id> --reason <reason> --reference <source|schema|native_artifact|repro>:<file> [...]", "Changed concrete platform evidence; never a prompt/model reset"],
] as const;

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
  const executingRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  if ((tier === "register-study" || tier === "study") && realpathSync(resolve(projectRoot)) !== executingRoot)
    throw new Error("Study source authority must be the executing evaluator module tree; foreign projectRoot overrides are unsupported");
  if (tier === "register-study" || tier === "study") projectRoot = executingRoot;
  if (!tier || tier === "--help" || tier === "help" || args.includes("--help")) {
    const commands = args.includes("--help") ? COMMANDS.filter(([name]) => name === tier) : COMMANDS;
    if (!commands.length) throw new Error("Unknown evaluation command");
    console.log(commands.map(([name, flags, description]) => `bun run evaluate ${name} ${flags}\n  ${description}`).join("\n"));
    console.log("StudySlot is {study_id,arm,initial_state_id,repetition}; quote the whole JSON argument. Admission-only runs no actor/game and rejects all external-resource flags. No command automatically builds Gradle/Vite or falls back to another model.");
    return 0;
  }
  if (tier === "register-study") {
    const path = resolve(projectRoot, takeValue(args, "--manifest"));
    if (args.length) throw new Error(`Unexpected study registration arguments: ${args.join(" ")}`);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Study manifest must be a real regular file without symlinks");
    const manifest = validateStudyManifest(JSON.parse(readFileSync(path, "utf8")), { projectRoot });
    const ledger = new StudyLedger(evaluationPaths(projectRoot).governanceRoot, { projectRoot });
    try { console.log(JSON.stringify({ study: ledger.registerStudy(manifest) })); } finally { ledger.close(); }
    return 0;
  }
  if (tier === "study") {
    const options = parseAgentAcceptanceArguments(args);
    if (!options.study) throw new Error("Study route requires --study, matching --manifest and declared --slot");
    const result = await runAgentAcceptance({ ...options, projectRoot });
    console.log(JSON.stringify(result));
    return result.platform_complete ? 0 : 1;
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
  if (tier !== "native-game" && tier !== "native-recording" && tier !== "agent-acceptance") throw new Error(`Choose ${COMMANDS.map(([name]) => name).join(", ")}`);
  requireTierOptIn((tier === "native-recording" ? "native-game" : tier) satisfies VerificationTier, { allowNative: args.includes("--allow-native"), allowInference: args.includes("--allow-inference") });
  const artifact = assertNativeArtifactFresh(projectRoot, takeValue(args, "--jar"));
  const script = tier === "native-game" ? "scripts/native-game.ts" : tier === "native-recording" ? "scripts/native-recording-proof.ts" : "scripts/agent-acceptance.ts";
  const childArgs = tier === "native-recording" ? [...args, "--jar", artifact.jarPath] : args;
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve(projectRoot, script), ...childArgs], {
    cwd: projectRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, GAMEHARNESS_NATIVE_PROOF: "1", GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256: artifact.sha256 },
  });
  return await child.exited;
}

if (import.meta.main) {
  try { process.exitCode = await runEvaluation(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
