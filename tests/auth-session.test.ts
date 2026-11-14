import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Keep dependency mutation and ambient-credential sentinels in a fresh process.
// These are generic auth/lifecycle regressions, not cognition or gameplay proof.
for (const scenario of [
  "provenance", "close", "logout", "models", "refresh", "agent", "row",
] as const) {
  test(`selected-account inference session: ${scenario}`, async () => {
    const child = Bun.spawn([
      process.execPath, "--no-env-file",
      fileURLToPath(new URL("./helpers/auth-session.fixture.ts", import.meta.url)),
      scenario,
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exit, stderr, stdout }).toEqual({ exit: 0, stderr: "", stdout: "ok\n" });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }, 15_000);
}
