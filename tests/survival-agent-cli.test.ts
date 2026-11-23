import { expect, test } from "bun:test";
import { join } from "node:path";

const runner = join(import.meta.dir, "..", "survival-agent/run.ts");
const runName = "2026-11-23T14-05-01.000Z-diamond-Ab1Cd2";

async function invoke(...args: string[]) {
  // Valid invocations reach the real display guard; invalid ones must stop before it.
  const child = Bun.spawn([process.execPath, "--no-env-file", runner, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, DISPLAY: "" },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("the parallel option works before, between and after ordinary arguments", async () => {
  for (const args of [
    ["--parallel-world", "diamond", "90"],
    ["diamond", "--parallel-world", "90", "--continue-from", runName],
    ["--strategy", "terra", "nether_portal", "90", "--parallel-world"],
  ]) {
    expect(await invoke(...args)).toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("refusing to use a desktop display"),
    });
  }
});

test("a literal parallel-world strategy task is not interpreted as an option", async () => {
  expect(await invoke("--strategy", "terra", "--control", "constrained", "--task", "--parallel-world",
    "diamond", "90", "--recover-crash-autosave", runName)).toMatchObject({
    code: 1, stdout: "", stderr: expect.stringContaining("refusing to use a desktop display"),
  });
});

test("the parallel option refuses recovery, incident replay, diagnostics and skill trials before setup", async () => {
  for (const args of [
    ["diamond", "90", "--recover-crash-autosave", runName],
    ["diamond", "90", "--replay-incident", runName],
    ["--diagnostic-pool"],
    ["--diagnostic-descent", "cave", "90"],
    ["--diagnostic-terrain", "ceiling", "90"],
    ["--diagnostic-urgent-creeper"],
    ["--diagnostic-urgent-craft"],
    ["--diagnostic-macro-trial"],
    ["--strategy", "terra", "--skill-trials", "allow", "diamond"],
  ]) {
    expect(await invoke(...args, "--parallel-world")).toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("--parallel-world is only available for ordinary"),
    });
  }
  expect(await invoke("--parallel-world", "diamond", "--parallel-world")).toMatchObject({
    code: 1, stdout: "", stderr: expect.stringContaining("Repeated --parallel-world"),
  });
});
