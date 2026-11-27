import { expect, test } from "bun:test";
import { join } from "node:path";
const runner = join(import.meta.dir, "../src/agent/run.ts");
const runName = "2026-11-23T14-05-01.000Z-diamond-Ab1Cd2";
async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", runner, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, DISPLAY: "", SURVIVAL_AGENT_ORPHAN_SCOPE: "" },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
test("ordinary v2 fresh, model, continuation and ore-assisted commands reach the real display guard", async () => {
  for (const args of [["--parallel-world", "diamond", "90"], ["diamond", "--parallel-world", "90", "--continue-from", runName],
    ["--strategy", "model", "--model", "fixture/model", "nether_portal", "90"], ["--diagnostic-reveal-ores", "diamond", "90"]])
    expect(await invoke(...args)).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("refusing to use a desktop display") });
});
test("parallel admission rejects recovery and diagnostic worlds before setup", async () => {
  for (const args of [["diamond", "90", "--recover-crash-autosave", runName], ["diamond", "90", "--recover-orphan-autosave", runName],
    ["diamond", "90", "--replay-incident", runName], ["--diagnostic-pool"]])
    expect(await invoke(...args, "--parallel-world")).toMatchObject({ code: 1, stderr: expect.stringContaining("only available for ordinary") });
});
test("same-boot recovery requires a scope and v1 diagnostics are not accepted", async () => {
  expect(await invoke("diamond", "90", "--recover-orphan-autosave", runName)).toMatchObject({ code: 1, stderr: expect.stringContaining("Set SURVIVAL_AGENT_ORPHAN_SCOPE") });
  for (const flag of ["--diagnostic-descent", "--diagnostic-terrain", "--diagnostic-macro-trial", "--diagnostic-urgent-creeper"])
    expect(await invoke(flag)).toMatchObject({ code: 1, stderr: expect.stringContaining("Usage:") });
  expect(await invoke("--parallel-world", "diamond", "--parallel-world")).toMatchObject({ code: 1, stderr: expect.stringContaining("Repeated --parallel-world") });
});
