import path from "node:path";
export async function runCheck(args: readonly string[], projectRoot = path.resolve(import.meta.dir, "..")) {
  const [kind = "types", ...selected] = args.filter(value => value !== "--");
  if (kind === "--help" || kind === "help") { console.log("bun run check [types | unit [test-file ...]]"); return 0; }
  let command: string[];
  if (kind === "types" && !selected.length) command = [path.join(projectRoot, "node_modules/.bin/tsc"), "--noEmit"];
  else if (kind === "unit") command = [process.execPath, "test", ...selected];
  else throw new Error("Choose types or unit; these checks never launch Minecraft or a model.");
  return await Bun.spawn(command, { cwd: projectRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}
if (import.meta.main) {
  try { process.exitCode = await runCheck(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
