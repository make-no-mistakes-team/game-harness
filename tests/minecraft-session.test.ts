import { expect, test } from "bun:test";
import { join } from "node:path";

for (const scenario of ["ready", "recheck", "mismatch-id", "mismatch-name", "http", "reader", "provider", "aborted"]) {
  test(`official session readiness uses the production verifier (${scenario})`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/minecraft-session.fixture.ts"), scenario], {
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "official-session fixture passed\n", stderr: "" });
  });
}
