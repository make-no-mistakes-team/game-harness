import { fileURLToPath } from "node:url";
import { parseAgentAcceptanceArguments, runAgentAcceptance, type AgentAcceptanceOptions } from "./agent-acceptance.ts";
import { minecraftDevelopmentSchema, type MinecraftDevelopmentDeclaration } from "../src/evaluation/minecraft-development.ts";
import { assertNativeArtifactFresh } from "../src/evaluation/tiers.ts";

export function parseMinecraftDevelopmentArguments(input: readonly string[]): AgentAcceptanceOptions & { development: MinecraftDevelopmentDeclaration } {
  const args = [...input];
  if (["--study", "--manifest", "--slot", "--admission-only", "--scenario"].some(flag => args.includes(flag)))
    throw new Error("Minecraft development is diagnostic admission, not a study or natural scenario selector");
  const take = (flag: string, required = true) => {
    const index = args.indexOf(flag);
    if (index < 0) { if (required) throw new Error(`Pass ${flag} explicitly`); return undefined; }
    const value = args[index+1];
    if (!value || value.startsWith("--")) throw new Error(`Pass ${flag} <value>`);
    args.splice(index,2); return value;
  };
  const reasoning = take("--reasoning", false);
  const development = minecraftDevelopmentSchema.parse({ task: take("--task"), seed: take("--seed"),
    start_description: take("--start-description"), criterion: take("--criterion", false),
    ...(reasoning === undefined ? {} : { reasoning }) });
  if (!args.includes("--model") || !args.includes("--jar")) throw new Error("Declare --model and --jar explicitly; no automatic fallback");
  const options = parseAgentAcceptanceArguments(args);
  return { ...options, development };
}

if (import.meta.main) {
  try {
    if (process.argv.includes("--help")) {
      console.log("Minecraft development: --allow-native --allow-inference --jar <fresh.jar> --auth-dir <existing-app-root> --hypothesis <existing-id> --evidence-revision <current> --model <discovered-image-model> --purpose <purpose> --justification <reason> --task <plain-text> [--criterion <registered-goal; default custom>] --seed <fresh-seed> --start-description <disclosure> [--max-requests N --run-ms N --total-ms N] [--reasoning low] [--single-inference-dispatch]. Reasoning defaults to the backend's unspecified effort; explicit low requires the discovered SDK model's supported effort and changes neither account nor model. The explicit single-dispatch condition uses SSE, rejects enabled PI_CODEX_WEBSOCKET, refuses inference redirects/replays and ends on provider error; it does not change the account/model or prove zero consumption. Fresh Normal Survival only; no prepared/restored saves, supplied inventory, setup commands, strategy injection or study allowance.");
      console.log("Use --evidence-profile <complete-private-profile.json> when default retention cannot cover --total-ms. Development retention covers the full original total, including recording prelude and drain; a 625000 ms envelope needs at least 18751 frames at nominal 30 Hz, including the final-frame margin.");
    } else {
      const options = parseMinecraftDevelopmentArguments(process.argv.slice(2));
      const project = fileURLToPath(new URL("..", import.meta.url));
      const artifact = assertNativeArtifactFresh(project, options.nativeJar!);
      process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
      const result = await runAgentAcceptance({ ...options, projectRoot: project });
      console.log(JSON.stringify(result, null, 2));
      if (!result.platform_complete) process.exitCode = 1;
    }
  } catch {
    console.error("Minecraft development did not complete; inspect private evidence. No retry, login, alternate model or account was started.");
    process.exitCode = 1;
  }
}
