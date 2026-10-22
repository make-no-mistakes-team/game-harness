import path from "node:path";
import { launchDesktop } from "./desktop.ts";

const root = path.resolve(import.meta.dir, "..");
const build = Bun.spawn([process.execPath, "run", "build"], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
let interrupted = false;
function cancelBuild(): void {
  interrupted = true;
  build.kill("SIGTERM");
}
process.once("SIGINT", cancelBuild);
process.once("SIGTERM", cancelBuild);
const code = await build.exited;
process.removeListener("SIGINT", cancelBuild);
process.removeListener("SIGTERM", cancelBuild);
if (interrupted || code !== 0) process.exit(code || 1);
// Serve the built renderer from the owned backend origin, including in development.
process.env.NODE_ENV = "development";
await launchDesktop();
