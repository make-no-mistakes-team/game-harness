import { expect, test } from "bun:test";

test("stopping cannot count an already observed last plan twice when an earlier plan was never applied", async () => {
  const child = Bun.spawn([process.execPath, new URL("./helpers/strategist-accounting.fixture.ts", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("counted once");
});
