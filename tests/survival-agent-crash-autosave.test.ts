import { expect, test } from "bun:test";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readCrashAutosave } from "../survival-agent/crash-autosave.ts";

const run = "2026-01-01T00-00-02.000Z-diamond-Xy4321";
const parent = "2026-01-01T00-00-01.000Z-iron_pickaxe-abc123";
const uuid = "5627dd98-e6be-3c21-b8a8-e92344183641";
const name = "Steve";
const iso = (ms: number) => new Date(ms).toISOString();

async function fixture<T>(use: (proof: {
  admit: (overrides?: Partial<Parameters<typeof readCrashAutosave>[0]>) => ReturnType<typeof readCrashAutosave>;
  root: string; runs: string; world: string;
}) => Promise<T>) {
  const temporary = await mkdtemp(join(tmpdir(), "crash-autosave-"));
  try {
    const runs = join(temporary, "ordinary/runs");
    const historicRuns = join(temporary, "legacy/runs");
    const root = join(runs, run);
    const server = join(root, "server");
    const world = join(server, "world");
    const live = join(temporary, "ordinary/live.json");
    for (const dir of [join(world, "region"), join(world, "playerdata"), join(world, "stats"), join(server, "logs")])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    const json = (path: string, record: unknown) => writeFile(path, JSON.stringify(record), { mode: 0o600 });
    const startedAt = "2026-01-01T00:00:02.005Z";
    await json(live, { run, active: true });
    await json(join(root, "declaration.json"), {
      schemaVersion: 1, startedAt, goal: "diamond", minecraftVersion: "1.21.4", agentJarSha256: "b".repeat(64),
      world: { type: "vanilla", mode: "survival", difficulty: "normal", fresh: false, parentRun: parent },
      claimScope: "continuation-chain",
      benchmark: { goal: "diamond", verifier: "vanilla-survival", claimScope: "continuation-chain" },
      connection: { host: "127.0.0.1", port: 12345, auth: "host-verified-official-launcher" },
      recording: { file: "screen.mp4" }, limits: { reserveBytes: 1_500_000_000 },
    });
    const events = ["declared", "world_copied", "server_started", "server_ready", "recorder_started", "client_started", "agent_ready"];
    await writeFile(join(root, "history.jsonl"), events.map((event, i) => JSON.stringify({
      event, at: iso(Date.parse(startedAt) + i), elapsedMs: i,
      ...(event === "world_copied" ? { parentRun: parent } : {}), ...(event === "agent_ready" ? { tick: 1 } : {}),
    })).join("\n") + "\n", { mode: 0o600 });
    await json(join(root, "progress.json"), { goal: "diamond", tick: 184, won: false });
    await writeFile(join(root, "screen.mp4"), Buffer.from([0, 0, 0, 8, ...Buffer.from("ftyp")]), { mode: 0o600 });
    await writeFile(join(server, "server.properties"), [
      "server-ip=127.0.0.1", "server-port=12345", "online-mode=false", "gamemode=survival", "force-gamemode=false",
      "difficulty=normal", "hardcore=false", "level-name=world", "max-players=1", "enable-rcon=false", "enable-query=false",
    ].join("\n"), { mode: 0o600 });
    await json(join(server, "usercache.json"), [{ name, uuid }]);
    await writeFile(join(server, "logs/latest.log"),
      `[00:00:03] [Server thread/INFO]: Starting minecraft server version 1.21.4\n` +
      `[00:00:05] [Server thread/INFO]: Default game type: SURVIVAL\n` +
      `[00:00:08] [Server thread/INFO]: ${name} joined the game\n`, { mode: 0o600 });
    const envelope = gzipSync(Buffer.from([10, 0, 0, 0]));
    await writeFile(join(world, "level.dat"), envelope, { mode: 0o600 });
    await writeFile(join(world, "session.lock"), "☃", { mode: 0o600 });
    await writeFile(join(world, "playerdata", `${uuid}.dat`), envelope, { mode: 0o600 });
    await json(join(world, "stats", `${uuid}.json`), { stats: {} });
    const region = Buffer.alloc(12_288);
    region.writeUIntBE(2, 0, 3);
    region[3] = 1;
    await writeFile(join(world, "region/r.0.0.mca"), region, { mode: 0o600 });
    return await use({
      root, runs, world,
      admit: (overrides = {}) => readCrashAutosave({
        runs, historicRuns, live, run, goal: "diamond", bootMs: Date.now() + 60_000,
        signal: new AbortController().signal, ...overrides,
      }),
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("the latest prior-boot ordinary save yields unclaimed autosave provenance without rewriting source evidence", async () => {
  await fixture(async ({ admit, root, world }) => {
    const history = await readFile(join(root, "history.jsonl"));
    const admitted = await admit({ goal: "nether_portal" });
    expect(admitted).toMatchObject({
      normalParentRun: parent, profileName: name,
      provenance: {
        kind: "previous-boot-crash-autosave", sourceRun: run, sourceLastObservedTick: 184,
        possibleProgressLoss: true, carriedClaim: null,
      },
    });
    expect(admitted.world).toBe(world);
    expect(admitted.provenance.sourceSaveLastWriteAt <= admitted.provenance.sourceLastActivityAt).toBe(true);
    expect(admitted.provenance.sourceLastActivityAt < admitted.provenance.recoveryKernelBootAt).toBe(true);
    expect(await readFile(join(root, "history.jsonl"))).toEqual(history);
  });
});

test("same-boot activity and an earlier goal cannot be admitted", async () => {
  await fixture(async ({ admit }) => {
    await expect(admit({ bootMs: Date.now() - 1_000 })).rejects.toThrow("during this boot");
    await expect(admit({ goal: "stone_pickaxe" })).rejects.toThrow("goal chain");
  });
});

test("any closing claim prevents crash recovery even when the source has no outcome", async () => {
  await fixture(async ({ admit, root }) => {
    await appendFile(join(root, "history.jsonl"), `${JSON.stringify({
      at: "2026-01-01T00:01:00.000Z", elapsedMs: 60_000, event: "server_drained",
    })}\n`);
    await expect(admit()).rejects.toThrow("closing claim");
  });
});

test("a won progress snapshot and a newer ordinary attempt each refuse recovery", async () => {
  await fixture(async ({ admit, root, runs }) => {
    await writeFile(join(root, "progress.json"), JSON.stringify({ goal: "diamond", tick: 184, won: true }));
    await expect(admit()).rejects.toThrow("unclaimed reported tick");
    await mkdir(join(runs, "2026-01-01T00-00-03.000Z-diamond-987abc"));
    await expect(admit()).rejects.toThrow("unique latest");
  });
});

test("a hard-linked tree or invalid Anvil table is not a recoverable vanilla save", async () => {
  await fixture(async ({ admit, root, world }) => {
    const source = join(world, "region/r.0.0.mca");
    const alias = join(root, "aliased-region.dat");
    await link(source, alias);
    await expect(admit()).rejects.toThrow("no links");
    await rm(alias);
    const region = await readFile(source);
    region[3] = 2;
    await writeFile(source, region);
    await expect(admit()).rejects.toThrow("vanilla region sector table");
  });
});
