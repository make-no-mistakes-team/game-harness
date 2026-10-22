import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tierTests } from "../src/evaluation/tiers.ts";

export async function runCheck(args: readonly string[], projectRoot = fileURLToPath(new URL("..", import.meta.url))): Promise<number> {
  const [tier = "types", ...selected] = args.filter(argument => argument !== "--");
  if (tier === "--help" || tier === "help") {
    console.log("bun run check [types | unit [test-file ...] | integration [test-file ...]]\nThese commands never build Java/UI, launch Minecraft/Docker or call a provider.\nbun test remains the broad local aggregation.");
    return 0;
  }
  let command: string[];
  if (tier === "types") {
    if (selected.length) throw new Error("Type checking accepts no test-file filters");
    command = [resolve(projectRoot, "node_modules/.bin/tsc"), "--noEmit"];
  } else if (tier === "unit" || tier === "integration") {
    command = [process.execPath, "test", ...tierTests(tier, selected).map(path => `./${path}`)];
  } else throw new Error("Choose types, unit or integration; native/agent evaluation requires bun run evaluate and explicit opt-ins");
  const child = Bun.spawn(command, { cwd: projectRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

if (import.meta.main) {
  try { process.exitCode = await runCheck(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
