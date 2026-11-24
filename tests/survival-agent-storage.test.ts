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
  crashAdmission: `
    const { Database } = await import("bun:sqlite");
    const { mkdirSync, statSync } = await import("node:fs");
    mkdirSync("local/survival-pilot", { recursive: true, mode: 0o700 });
    const owner = new Database("local/survival-pilot/owner.sqlite");
    const diagnostic = new Database("local/survival-pilot/diagnostic-owner.sqlite");
    const ledgerPath = "local/survival-pilot/admission.sqlite";
    const ledger = new Database(ledgerPath);
    ledger.exec(\`
      CREATE TABLE reservations (id INTEGER PRIMARY KEY, generation INTEGER, survival INTEGER, diagnostic INTEGER);
      INSERT INTO reservations VALUES (1, 10, 7, 0);
    \`);
    let state = () => ledger.query("SELECT generation, survival, diagnostic FROM reservations").get();
    const writtenAt = Math.ceil(statSync(ledgerPath).mtimeMs);
    const startedAtMs = writtenAt + (process.env.CASE === "newer-owner" ? -1 : 20_000);
    const proof = { startedAtMs, bootMs: writtenAt + 50_000, priorReserveBytes: 7 };
    if (process.env.CASE === "active-owner") owner.exec("BEGIN IMMEDIATE");
    if (process.env.CASE === "unknown-diagnostic") {
      ledger.exec("UPDATE reservations SET diagnostic = 9");
      diagnostic.exec("BEGIN IMMEDIATE");
    }
    try {
      const release = process.env.CASE === "ordinary" ? await admitRun(11) : await admitRun(11, "survival", proof);
      const admitted = state();
      release();
      console.log(JSON.stringify({ admitted, released: state() }));
    } catch (error) {
      console.error(error.message);
      console.log(JSON.stringify(state()));
      process.exitCode = 1;
    } finally {
      owner.close(); diagnostic.close(); ledger.close();
    }
  `,
  orphanAdmission: `
    const { Database } = await import("bun:sqlite");
    const second = await admitRun(17, "diagnostic");
    const root = "local/survival-pilot/";
    const primary = new Database(root + "owner.sqlite");
    const ledger = new Database(root + "admission.sqlite");
    ledger.exec("UPDATE reservations SET survival = 7, generation = generation + 1");
    const state = () => ledger.query("SELECT generation, survival, diagnostic FROM reservations").get();
    const scenario = process.env.CASE;
    let proofComplete = false;
    const proof = {
      kind: "same-boot-orphan-autosave",
      sourceRun: "2026-11-23T14-05-01.000Z-diamond-Ab1Cd2",
      priorReserveBytes: scenario === "orphan-wrong-charge" ? 8 : 7,
      signal: new AbortController().signal,
      assertSource() {
        if (scenario === "orphan-wrong-source" || scenario === "orphan-source-raced" && proofComplete)
          throw new Error("The primary source marker changed.");
      },
      async assertQuiescent() {
        if (scenario === "orphan-unknown-writer") throw new Error("Cannot prove source writers are gone.");
        proofComplete = true;
        try {
          primary.exec("BEGIN IMMEDIATE");
        } catch (error) {
          if (error.code === "SQLITE_BUSY") return;
          throw error;
        }
        primary.exec("ROLLBACK");
        throw new Error("The final evidence check did not hold the primary lock.");
      },
    };
    if (scenario === "orphan-active-owner") primary.exec("BEGIN IMMEDIATE");
    if (scenario === "orphan-unlocked-secondary") {
      second();
      ledger.exec("UPDATE reservations SET diagnostic = 17, generation = generation + 1");
    }
    try {
      // Equal charges must still consume the older source exactly once.
      const release = await admitRun(7, "survival", proof);
      const admitted = state();
      let secondLocked = false;
      try { (await admitRun(19, "diagnostic"))(); }
      catch (error) { secondLocked = error.message.includes("already has an active run"); }
      release();
      const released = state();
      if (scenario === "orphan-replay") {
        // Simulate a new equal-byte stranded charge without a matching new live marker.
        ledger.exec("UPDATE reservations SET survival = 7, generation = generation + 1");
        (await admitRun(7, "survival", proof))();
      }
      second();
      console.log(JSON.stringify({ admitted, secondLocked, released, drained: state() }));
    } catch (error) {
      console.error(error.message);
      console.log(JSON.stringify(state()));
      process.exitCode = 1;
    } finally { primary.close(); ledger.close(); second(); }
  `,
  concurrentAdmission: `
    const { Database } = await import("bun:sqlite");
    const primary = await admitRun(11);
    const second = await admitRun(17, "diagnostic");
    const db = new Database("local/survival-pilot/admission.sqlite", { readonly: true });
    const state = () => db.query("SELECT survival, diagnostic FROM reservations").get();
    const refused = async (lane) => {
      try {
        (await admitRun(19, lane))();
        return "admitted";
      } catch (error) { return error.message; }
    };
    const held = state();
    const deniedPrimary = await refused("survival");
    const deniedSecond = await refused("diagnostic");
    second();
    const remaining = state();
    primary();
    console.log(JSON.stringify({ held, deniedPrimary, deniedSecond, remaining, drained: state() }));
    db.close();
  `,
  aggregateAdmission: `
    const primary = await admitRun(900_000);
    let refused;
    try { (await admitRun(900_000, "diagnostic"))(); }
    catch (error) { refused = error.message; }
    const second = await admitRun(90_000, "diagnostic");
    second();
    primary();
    console.log(refused);
  `,
  unaccountedSecondLane: `
    const { Database } = await import("bun:sqlite");
    const { mkdirSync } = await import("node:fs");
    mkdirSync("local/survival-pilot", { recursive: true, mode: 0o700 });
    const legacy = new Database("local/survival-pilot/diagnostic-owner.sqlite");
    const refused = async () => {
      try {
        (await admitRun(19, "diagnostic"))();
        return "admitted";
      } catch (error) { return error.message; }
    };
    legacy.exec("BEGIN IMMEDIATE");
    const unaccounted = await refused();
    legacy.close();
    const db = new Database("local/survival-pilot/admission.sqlite");
    db.exec("UPDATE reservations SET diagnostic = 7 WHERE id = 1");
    const stranded = await refused();
    const reservation = db.query("SELECT diagnostic FROM reservations").get();
    console.log(JSON.stringify({ unaccounted, stranded, reservation }));
    db.close();
  `,
  campaignActivation: `
    const release = await storage.admitRun(11);
    try {
      (await admitRun(1, "diagnostic"))();
      throw new Error("The live legacy reservation was reclassified.");
    } catch (error) {
      console.log(error.message);
    } finally { release(); }
  `,
  campaignProcesses: `
    const { Database } = await import("bun:sqlite");
    const first = await admitRun(1);
    first();
    const children = ["survival", "diagnostic"].map(lane => Bun.spawn([
      process.execPath, "--no-env-file", "--eval", \`
        const { admitRun } = await import("./survival-agent/storage.ts");
        const release = await admitRun(17, "\${lane}", undefined, { campaign: "recovery-development" });
        console.log("held");
        for await (const line of console) { if (line === "drain") break; }
        release();
      \`,
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env }));
    const ledger = new Database("local/survival-pilot/admission.sqlite", { readonly: true });
    const state = () => ledger.query("SELECT survival, diagnostic FROM reservations").get();
    try {
      await Promise.all(children.map(async child => {
        const reader = child.stdout.getReader();
        try {
          const result = await reader.read();
          if (result.done || new TextDecoder().decode(result.value).trim() !== "held")
            throw new Error("A concurrent owner did not reserve its lane.");
        } finally { reader.releaseLock(); }
      }));
      const held = state();
      children[1].stdin.write("drain\\n"); children[1].stdin.end();
      if (await children[1].exited !== 0) throw new Error("Second process did not drain.");
      const remaining = state();
      children[0].stdin.write("drain\\n"); children[0].stdin.end();
      if (await children[0].exited !== 0) throw new Error("First process did not drain.");
      console.log(JSON.stringify({ held, remaining, drained: state() }));
    } finally {
      for (const child of children) { if (child.exitCode === null) child.kill(); }
      await Promise.all(children.map(child => child.exited));
      ledger.close();
    }
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

async function withScanner(scenario: string, command: keyof typeof commands = "admission", campaign = false) {
  const project = mkdtempSync(join(realpathSync(tmpdir()), "survival-admission-"));
  try {
    // Use the real entry point and ledger in a temporary checkout. Only the
    // external scanner's replies are scripted, so no timing race is required.
    for (const directory of ["survival-agent", "src/evaluation", "bin", "runtime", "reports", "governance", "data"])
      mkdirSync(join(project, directory), { recursive: true });
    for (const source of ["survival-agent/storage.ts", "survival-agent/storage-campaign.ts", "src/evaluation/paths.ts"])
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
total=$(($# * 4096))
first=4096
if [ "$CASE" = nearly-full ]; then
  total=246311908800
  first=$((total - ($# - 1) * 4096))
fi
for root; do
  printf '%s\\t%s\\000' "$first" "$root"
  first=4096
done
case "$CASE" in
  malformed) printf '\\ttotal\\000' ;;
  truncated) printf '%s\\ttotal' "$total" ;;
  *) printf '%s\\ttotal\\000' "$total" ;;
esac
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
      if (process.env.CASE === "campaign-soft-limit") {
        const { mock } = await import("bun:test");
        const original = await import("./survival-agent/storage-campaign.ts");
        mock.module("./survival-agent/storage-campaign.ts", () => ({
          ...original, campaignBytes: () => 400_000_000_001,
        }));
      }
      const storage = await import("./survival-agent/storage.ts");
      const { diskBytes } = storage;
      const admitRun = ${campaign}
        ? (bytes, lane, recovery) => storage.admitRun(bytes, lane, recovery, { campaign: "recovery-development" })
        : storage.admitRun;
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
    const roots = command === "measure" || command === "abort"
      ? ["runtime"] : ["local", "runtime", "reports", "governance", "data"];
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

test("opt-in recovery replaces exactly the attributed unlocked reservation and releases only its own", async () => {
  const result = await withScanner("crash", "crashAdmission");
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 1 });
  expect(JSON.parse(result.stdout)).toEqual({
    admitted: { generation: 11, survival: 11, diagnostic: 0 },
    released: { generation: 12, survival: 0, diagnostic: 0 },
  });
});

test("same-boot recovery reattributes only primary storage while the second owner remains charged and locked", async () => {
  const result = await withScanner("orphan", "orphanAdmission");
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 2 });
  expect(JSON.parse(result.stdout)).toEqual({
    admitted: { generation: 3, survival: 7, diagnostic: 17 },
    secondLocked: true,
    released: { generation: 4, survival: 0, diagnostic: 17 },
    drained: { generation: 5, survival: 0, diagnostic: 0 },
  });
});

for (const [scenario, reason, attempts, generation] of [
  ["orphan-wrong-charge", "not attributable", 1, 2],
  ["orphan-active-owner", "already has an active run", 1, 2],
  ["orphan-wrong-source", "source marker changed", 1, 2],
  ["orphan-source-raced", "source marker changed", 2, 2],
  ["orphan-unknown-writer", "Cannot prove source writers are gone", 2, 2],
  ["orphan-unlocked-secondary", "diagnostic run left an unreleased reservation", 1, 4],
  ["orphan-replay", "already reattributed", 2, 5],
] as const) {
  test(`same-boot recovery refuses ${scenario} without altering either charge`, async () => {
    const result = await withScanner(scenario, "orphanAdmission");
    expect(result).toMatchObject({ code: 1, attempts });
    expect(result.stderr).toContain(reason);
    expect(JSON.parse(result.stdout)).toEqual({ generation, survival: 7, diagnostic: 17 });
  });
}

test("the primary and second physical owner share one ledger without releasing each other's reservations", async () => {
  const result = await withScanner("concurrent", "concurrentAdmission");
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 2 });
  expect(JSON.parse(result.stdout)).toEqual({
    held: { survival: 11, diagnostic: 17 },
    deniedPrimary: "The survival lane already has an active run.",
    deniedSecond: "The diagnostic lane already has an active run.",
    remaining: { survival: 11, diagnostic: 0 },
    drained: { survival: 0, diagnostic: 0 },
  });
});

test("the second physical owner charges the existing primary reservation against the aggregate cap", async () => {
  const result = await withScanner("nearly-full", "aggregateAdmission");
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 3 });
  expect(result.stdout).toContain("246311908800 bytes counted, 900000 reserved for agent runs, 900000 requested");
});

test("the second physical owner refuses both a legacy lock without a reservation and a stranded reservation", async () => {
  const result = await withScanner("unaccounted", "unaccountedSecondLane");
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 0 });
  expect(JSON.parse(result.stdout)).toMatchObject({
    unaccounted: expect.stringContaining("locked without a shared reservation"),
    stranded: expect.stringContaining("left an unreleased reservation"),
    reservation: { diagnostic: 7 },
  });
});

for (const [scenario, reason, diagnostic] of [
  ["ordinary", "left an unreleased reservation", 0],
  ["newer-owner", "not attributable", 0],
  ["active-owner", "already has an active run", 0],
  ["unknown-diagnostic", "not attributable", 9],
] as const) {
  test(`recovery never clears a reservation for ${scenario}`, async () => {
    const result = await withScanner(scenario, "crashAdmission");
    expect(result).toMatchObject({ code: 1, attempts: 0 });
    expect(result.stderr).toContain(reason);
    expect(JSON.parse(result.stdout)).toEqual({ generation: 10, survival: 7, diagnostic });
  });
}

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

test("the explicit development campaign keeps the shared lane ownership and independent releases", async () => {
  const result = await withScanner("concurrent", "concurrentAdmission", true);
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 0 });
  expect(JSON.parse(result.stdout)).toEqual({
    held: { survival: 11, diagnostic: 17 },
    deniedPrimary: "The survival lane already has an active run.",
    deniedSecond: "The diagnostic lane already has an active run.",
    remaining: { survival: 11, diagnostic: 0 },
    drained: { survival: 0, diagnostic: 0 },
  });
});

test("crossing the development campaign ceiling warns without refusing a physically safe reservation", async () => {
  const result = await withScanner("campaign-soft-limit", "admission", true);
  expect(result).toMatchObject({ code: 0, stdout: "admitted", attempts: 0 });
  expect(result.stderr).toContain("Development artifact soft ceiling exceeded: 400000000001 new bytes counted");
  expect(result.stderr).toContain("soft limit 400000000000");
});

test("campaign initialization never reclassifies an active legacy reservation as historical", async () => {
  const result = await withScanner("campaign-activation", "campaignActivation", true);
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 1 });
  expect(result.stdout).toContain("only after both lanes have drained");
});

test("separate development processes preserve both charges until each owner drains", async () => {
  const result = await withScanner("campaign-processes", "campaignProcesses", true);
  expect(result).toMatchObject({ code: 0, stderr: "", attempts: 0 });
  expect(JSON.parse(result.stdout)).toEqual({
    held: { survival: 17, diagnostic: 17 },
    remaining: { survival: 17, diagnostic: 0 },
    drained: { survival: 0, diagnostic: 0 },
  });
});
