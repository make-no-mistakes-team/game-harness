import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { osMonotonicNs } from "../src/agent/paths.ts";

test("native workflow timestamps use one OS clock across independently started Bun processes", () => {
  const module = fileURLToPath(
    new URL("../src/agent/paths.ts", import.meta.url),
  );
  const before = osMonotonicNs();
  const child = spawnSync(
    process.execPath,
    [
      "--no-env-file",
      "-e",
      `import {osMonotonicNs} from ${JSON.stringify(module)}; console.log(osMonotonicNs().toString());`,
    ],
    {
      encoding: "utf8",
      env: { LANG: "C.UTF-8" },
      timeout: 2000,
      maxBuffer: 8192,
    },
  );
  const after = osMonotonicNs();
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe("");
  expect(child.stdout.trim()).toMatch(/^[1-9][0-9]*$/);
  const observed = BigInt(child.stdout.trim());
  expect(observed >= before).toBe(true);
  expect(observed <= after).toBe(true);
});
