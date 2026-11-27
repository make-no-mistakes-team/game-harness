import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savedWorld } from "../survival-agent/run.ts";

test("ordinary continuation refuses ore-assisted or explicitly non-campaign parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "gameharness-continuation-"));
  const runs = join(root, "runs"), name = "2026-11-23T14-05-01.000Z-diamond-Ab1Cd2";
  const run = join(runs, name), world = join(run, "server/world");
  try {
    await mkdir(join(world, "region"), { recursive: true, mode: 0o700 });
    const declaration = { schemaVersion: 1, goal: "diamond", minecraftVersion: "1.21.4",
      agentJarSha256: "a".repeat(64), startedAt: "2026-11-23T14:05:01.000Z",
      connection: { host: "127.0.0.1", auth: "host-verified-official-launcher" },
      recording: { file: "screen.mp4" },
      world: { type: "vanilla", mode: "survival", difficulty: "normal", fresh: true, seed: "random" },
      claimScope: "fresh-attempt" };
    const outcome = { schemaVersion: 1, goal: "diamond", startedAt: declaration.startedAt,
      finishedAt: "2026-11-23T14:06:01.000Z", status: "interrupted", progress: null,
      exits: { server: { code: 0, signal: null } } };
    for (const [file, content] of Object.entries({
      "outcome.json": JSON.stringify(outcome),
      "history.jsonl": JSON.stringify({ event: "closed", status: "interrupted", at: outcome.finishedAt }) + "\n",
      "screen.mp4": "recording", "server/world/level.dat": "world", "server/world/session.lock": "lock",
    })) await writeFile(join(run, file), content);
    const signal = new AbortController().signal;
    await writeFile(join(run, "declaration.json"), JSON.stringify(declaration));
    expect((await savedWorld(name, "diamond_pickaxe", signal, [runs])).world).toBe(world);
    for (const changed of [{ claimScope: "ore-assisted-diagnostic" }, { campaignProof: false }]) {
      await writeFile(join(run, "declaration.json"), JSON.stringify({ ...declaration, ...changed }));
      await expect(savedWorld(name, "diamond_pickaxe", signal, [runs])).rejects.toThrow("Cannot continue");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
