import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commands = {
  admission: `
    const release = await admitRun(1);
    release();
    console.log("admitted");
  `,
  measure: `console.log(await diskBytes("./runtime"));`,
  abort: `
    const controller = new AbortController();
    const reason = new Error("ordinary stop");
    const scanning = diskBytes("./runtime", controller.signal).then(() => null, error => error);
    let pid = 0;
    const deadline = performance.now() + 2_000;
    while (!pid && performance.now() < deadline) {
      pid = Number(await Bun.file(process.env.SCAN_PID).text().catch(() => ""));
      if (!pid) await Bun.sleep(5);
    }
    const startedAbort = performance.now();
    controller.abort(reason);
    if (await scanning !== reason || !pid || performance.now() - startedAbort > 2_000)
      throw new Error("Expected prompt propagation of the caller's stop.");
    try {
      process.kill(pid, 0);
      throw new Error("The scanner was still alive after cancellation.");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    console.log("canceled and drained");
  `,
};

async function withScanner(scenario: string, command: keyof typeof commands = "admission") {
  const project = mkdtempSync(join(realpathSync(tmpdir()), "survival-admission-"));
  try {
    // Use the real entry point and ledger in a temporary checkout. Only the
    // external scanner's replies are scripted, so no timing race is required.
    for (const directory of ["survival-agent", "src/evaluation", "bin", "runtime", "reports", "governance", "data"])
      mkdirSync(join(project, directory), { recursive: true });
    for (const source of ["survival-agent/storage.ts", "src/evaluation/paths.ts"])
      copyFileSync(join(import.meta.dir, "..", source), join(project, source));
    const scans = join(project, "scans");
    writeFileSync(scans, "");
    writeFileSync(join(project, "bin/du"), `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] || exit 90
shift
[ "$LC_ALL" = C ] || exit 91
[ -s "$SCAN_LOG" ] && first=no || first=yes
printf '%s\\n' "$*" >> "$SCAN_LOG"
case "$CASE" in
  vanished|always-vanishes|mixed)
    if [ "$first" = yes ] || [ "$CASE" != vanished ]; then
      printf "du: cannot access '%s/private-temp': No such file or directory\\n" "$1" >&2
      [ "$CASE" != mixed ] || printf "du: cannot read directory '%s/private-data': Permission denied\\n" "$1" >&2
      printf '0\\ttotal\\000'
      exit 1
    fi ;;
  io)
    printf "du: '%s/private-data': Input/output error\\n" "$1" >&2
    exit 1 ;;
  excessive-diagnostics)
    printf '%65537s\\n' '' >&2
    exit 1 ;;
  blocked)
    printf '%s\\n' "$$" > "$SCAN_PID"
    exec sleep 4 ;;
esac
for root; do printf '4096\\t%s\\000' "$root"; done
total=$(($# * 4096))
case "$CASE" in
  malformed) printf '\\ttotal\\000' ;;
  truncated) printf '%s\\ttotal' "$total" ;;
  *) printf '%s\\ttotal\\000' "$total" ;;
esac
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
      import { admitRun, diskBytes } from "./survival-agent/storage.ts";
      try {
        ${commands[command]}
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    `], {
      cwd: project, stdout: "pipe", stderr: "pipe",
      env: {
        PATH: `${join(project, "bin")}:/usr/bin:/bin`, CASE: scenario, SCAN_LOG: scans, SCAN_PID: join(project, "scanner-pid"),
        GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(project, "runtime"),
        GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(project, "reports"),
        GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: join(project, "governance"),
        GAMEHARNESS_DATA_DIR: join(project, "data"),
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const roots = command === "admission" ? ["local", "runtime", "reports", "governance", "data"] : ["runtime"];
    const fullScan = roots.map(name => join(project, name)).join(" ");
    const attempts = readFileSync(scans, "utf8").split("\n").slice(0, -1);
    for (const attempt of attempts) expect(attempt).toBe(fullScan);
    return { stdout: stdout.trim(), stderr: stderr.trim(), code, attempts: attempts.length };
  } finally { rmSync(project, { recursive: true, force: true }); }
}

test("admission retries a vanished entry with a fresh full scan", async () => {
  expect(await withScanner("vanished")).toEqual({
    stdout: "admitted", stderr: "", code: 0, attempts: 2,
  });
});

test("admission refuses repeated vanished entries after bounded full scans", async () => {
  expect(await withScanner("always-vanishes")).toEqual({
    stdout: "", stderr: "Cannot account for existing run storage (entries vanished; du exit 1)",
    code: 1, attempts: 3,
  });
});

for (const [scenario, category] of [
  ["mixed", "permission denied; du exit 1"], ["io", "I/O error; du exit 1"],
  ["malformed", "malformed du output; du exit 0"], ["truncated", "malformed du output; du exit 0"],
  ["excessive-diagnostics", "du output exceeded limit; du exit 1"],
] as const) {
  test(`admission refuses ${scenario} scanner output without retrying or exposing paths`, async () => {
    expect(await withScanner(scenario)).toEqual({
      stdout: "", stderr: `Cannot account for existing run storage (${category})`, code: 1, attempts: 1,
    });
  });
}

test("a live measurement retries a vanished entry and returns only the complete sample", async () => {
  expect(await withScanner("vanished", "measure")).toEqual({
    stdout: "4096", stderr: "", code: 0, attempts: 2,
  });
});

test("canceling an in-flight live measurement joins the scanner and preserves the stop reason", async () => {
  expect(await withScanner("blocked", "abort")).toEqual({
    stdout: "canceled and drained", stderr: "", code: 0, attempts: 1,
  });
});
