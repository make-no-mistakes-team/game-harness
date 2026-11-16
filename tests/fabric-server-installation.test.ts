import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./helpers/fabric-server-installation.fixture.ts", import.meta.url));
interface Result {
  error: string | null;
  spawnCount: number;
  childClosed: boolean;
  childAlive: boolean;
  argumentsAtSpawn: string[];
  preseedBytes: number | null;
  hasReceipt: boolean;
  fetches: number;
  deadlineMs: number | null;
  stagedTemporaryFiles: string[];
  userFile: string | null;
  metadataMode: number;
  sourceDirectoryMode: number;
  destinationDirectoryMode: number;
  launcherMode: number | null;
}
function run(mode: string): Result {
  const result = spawnSync(process.execPath, ["--no-env-file", fixture, mode], {
    encoding: "utf8", timeout: 15000,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

test("a launcher left by an incomplete installation still invokes pinned Fabric instead of reporting ready", () => {
  const result = run("launcher-only");
  expect(result.spawnCount).toBe(1);
  expect(result.argumentsAtSpawn.slice(-8)).toEqual(["server", "-mcversion", "1.21.4", "-loader", "0.16.10", "-downloadMinecraft", "-dir", expect.any(String)]);
  expect(result.error).toContain("reason=nonzero_exit; exit=23; signal=none");
  expect(result.error).not.toContain("PRIVATE THIRD PARTY OUTPUT");
  expect(result.hasReceipt).toBe(false);
  expect(result.childClosed).toBe(true);
  expect(result.childAlive).toBe(false);
});

for (const mode of ["wrong-version", "truncated", "corrupt", "source-symlink", "source-directory-symlink", "source-directory-public", "destination-directory-public", "outside-source", "destination-symlink"]) {
  test(`the real provisioning consumer rejects ${mode} without spawning Java or accepting an installation`, () => {
    const result = run(mode);
    expect(result.error).not.toBeNull();
    expect(result.spawnCount).toBe(0);
    expect(result.fetches).toBe(0);
    expect(result.hasReceipt).toBe(false);
    expect(result.stagedTemporaryFiles).toEqual([]);
    expect(result.metadataMode).toBe(0o664);
    if (mode === "wrong-version") expect(result.error).toBe("Pinned public server artifact is invalid or unsafe.");
    if (mode === "source-directory-public") expect(result.sourceDirectoryMode).toBe(0o750);
    if (mode === "destination-directory-public") expect(result.destinationDirectoryMode).toBe(0o750);
    if (mode === "destination-symlink") expect(result.userFile).toBe("must not be overwritten");
  });
}

for (const [mode, reason] of [["nonzero", "nonzero_exit"], ["spawn-failure", "spawn_failure"], ["caller-abort", "caller_abort"], ["timeout", "timeout"]] as const) {
  test(`installer ${mode} retains a safe terminal reason and settles only after child closure`, () => {
    const result = run(mode);
    expect(result.spawnCount).toBe(1);
    expect(result.error).toContain(`stage=installer; reason=${reason};`);
    expect(result.error).not.toContain("PRIVATE THIRD PARTY OUTPUT");
    expect(result.hasReceipt).toBe(false);
    expect(result.childClosed).toBe(true);
    expect(result.childAlive).toBe(false);
    if (mode === "timeout") {
      expect(result.deadlineMs).toBe(240000);
      expect(result.error).toContain("signal=SIGKILL");
    }
    if (mode === "caller-abort") expect(result.error).toContain("signal=SIGKILL");
  });
}

test("a zero-exit installer without the verified server artifact cannot publish a completion receipt", () => {
  const result = run("empty-success");
  expect(result.spawnCount).toBe(1);
  expect(result.childClosed).toBe(true);
  expect(result.error).not.toBeNull();
  expect(result.hasReceipt).toBe(false);
});
