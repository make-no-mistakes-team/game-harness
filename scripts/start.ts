import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, PROJECT_ROOT } from "../src/server/config.ts";

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const child = Bun.spawn(
  [
    "flock",
    "--nonblock",
    "--no-fork",
    path.join(DATA_DIR, "app.lock"),
    process.execPath,
    path.join(PROJECT_ROOT, "src/server/index.ts"),
  ],
  {
    cwd: PROJECT_ROOT,
    env: { ...process.env, GAMEHARNESS_LOCK_HELD: "1", NODE_ENV: "production" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
const code = await child.exited;
if (code !== 0)
  console.error(
    "GameHarness could not start or exited with an error. Check that another instance is not using this data directory.",
  );
process.exit(code);
