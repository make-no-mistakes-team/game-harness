import { createRequire } from "node:module";
import path from "node:path";

export async function launchDesktop(): Promise<never> {
  const root = path.resolve(import.meta.dir, "..");
  const executable: unknown = createRequire(import.meta.url)("electron");
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new Error(
      "Electron is unavailable. Install the pinned Electron package and its desktop binary first.",
    );
  }
  const environment: Record<string, string | undefined> = {
    ...process.env,
    GAMEHARNESS_BUN: process.execPath,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const desktop = Bun.spawn([executable, path.join(root, "desktop/main.cjs")], {
    cwd: root,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let closing = false;
  function close(): void {
    if (closing) return;
    closing = true;
    desktop.kill("SIGTERM");
  }
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.exit(await desktop.exited);
}
