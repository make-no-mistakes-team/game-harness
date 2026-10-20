import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, PROJECT_ROOT } from "../src/server/config.ts";

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const build = Bun.spawn([process.execPath, "run", "build:bridge"], {
  cwd: PROJECT_ROOT,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) process.exit(1);
const backend = Bun.spawn(
  [
    "flock",
    "--nonblock",
    "--no-fork",
    path.join(DATA_DIR, "app.lock"),
    process.execPath,
    "--watch",
    "src/server/index.ts",
  ],
  {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      GAMEHARNESS_LOCK_HELD: "1",
      NODE_ENV: "development",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
const frontend = Bun.spawn([process.execPath, "x", "--no-install", "vite"], {
  cwd: PROJECT_ROOT,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  frontend.kill("SIGTERM");
  backend.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const code = await Promise.race([backend.exited, frontend.exited]);
stop();
await Promise.allSettled([backend.exited, frontend.exited]);
process.exit(code);
