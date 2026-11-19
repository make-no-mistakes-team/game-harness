import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeLedger, lifeReceiptReader } from "../survival-agent/lives.ts";

function frame(tick: number, deaths: number, phase: "playing" | "death_screen" | "respawn_requested") {
  const alive = phase === "playing";
  const respawns = alive ? deaths : deaths - 1;
  return { tick, deaths, respawns, life: 1 + respawns, life_phase: phase, alive, wall_ms: 1_000 + tick };
}

test("a complete life between snapshots preserves exact receipts and fails a prepared proof", () => {
  const ledger = new LifeLedger(false);
  ledger.snapshot(frame(1, 0, "playing"), 10);
  ledger.receipt(frame(2, 1, "death_screen"), 50);
  ledger.receipt(frame(3, 1, "respawn_requested"), 50);
  ledger.receipt(frame(3, 1, "playing"), 50);
  ledger.snapshot(frame(20, 1, "playing"), 50);
  expect(ledger.stop(50)?.status).toBe("died");
  expect(ledger.summary()).toMatchObject({
    deaths: 1, respawns: 1, life: 2, firstDeath: {
      life: 1,
      death: { tick: 2, wall_ms: 1002, source: "lives.jsonl" },
      requested: { tick: 3, wall_ms: 1003, source: "lives.jsonl" },
      observed: { tick: 3, wall_ms: 1003, source: "lives.jsonl" },
    },
  });
});

test("monotonic counters catch skipped deaths without inventing receipt timestamps", () => {
  const ledger = new LifeLedger(false);
  ledger.snapshot(frame(1, 0, "playing"), 0);
  ledger.snapshot(frame(20, 2, "playing"), 350);
  expect(ledger.stop(350)?.status).toBe("died");
  expect(ledger.summary()).toMatchObject({ deaths: 2, respawns: 2, life: 3, firstDeath: null });
});

test("ordinary recovery invalidates the previous life and does not reset the pending deadline", () => {
  const ledger = new LifeLedger(true);
  const prior = frame(1, 0, "playing");
  ledger.snapshot(prior, 0);
  ledger.receipt(frame(2, 1, "death_screen"), 100);
  ledger.receipt(frame(3, 1, "respawn_requested"), 1_000);
  const loading = { ...frame(4, 1, "respawn_requested"), alive: true };
  ledger.snapshot(loading, 1_200);
  expect(ledger.currentPlaying(prior)).toBe(false);
  expect(ledger.currentPlaying(loading)).toBe(false);
  expect(ledger.stop(15_100)?.status).toBe("respawn_timeout");
  const current = frame(20, 1, "playing");
  ledger.receipt(frame(4, 1, "playing"), 1_500);
  ledger.snapshot(current, 2_000);
  expect(ledger.stop(2_000)).toBeNull();
  expect(ledger.currentPlaying(current)).toBe(true);
});

test("three fast deaths require a new objective milestone, not just another life", () => {
  const ledger = new LifeLedger(true);
  ledger.snapshot(frame(1, 0, "playing"), 0);
  ledger.snapshot(frame(20, 1, "playing"), 5_000);
  ledger.snapshot(frame(30, 2, "playing"), 8_000);
  ledger.milestone(["stonePickaxe"]);
  ledger.snapshot(frame(40, 3, "playing"), 12_000);
  ledger.snapshot(frame(50, 4, "playing"), 20_000);
  expect(ledger.stop(20_000)).toBeNull();
  ledger.milestone(["sticks", "planks"]);
  ledger.snapshot(frame(60, 5, "playing"), 25_000);
  expect(ledger.stop(25_000)?.status).toBe("died");
});

test("legacy playback is strict and mixed or decreasing counters are rejected", () => {
  const legacy = new LifeLedger(true);
  legacy.snapshot({ tick: 1, alive: true }, 0);
  legacy.snapshot({ tick: 20, alive: false }, 200);
  expect(legacy.stop(200)?.status).toBe("died");
  expect(() => legacy.snapshot(frame(30, 1, "playing"), 300)).toThrow();

  const ledger = new LifeLedger(true);
  ledger.snapshot(frame(1, 0, "playing"), 0);
  ledger.snapshot(frame(20, 1, "playing"), 100);
  expect(() => ledger.snapshot(frame(30, 0, "playing"), 200)).toThrow();
});

test("an in-flight private append is ingested exactly once and late reads keep original death time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "survival-agent-lives-"));
  try {
    const file = join(dir, "lives.jsonl");
    const read = lifeReceiptReader(file);
    const ledger = new LifeLedger(true);
    const receive: Parameters<typeof read>[0] = row => ledger.receipt(row, 600_000);
    expect(await read(receive)).toBe(false);

    const death = `${JSON.stringify(frame(2, 1, "death_screen"))}\n`;
    await appendFile(file, death.slice(0, 8), { mode: 0o600 });
    expect(await read(receive)).toBe(true);
    expect(ledger.deaths).toBe(0);
    await appendFile(file, death.slice(8));
    for (const [life, tick] of [[1, 3], [2, 7], [3, 11]] as const) {
      const wall = life === 1 ? 1002 : life * 180_000;
      const frames = [
        ...(life === 1 ? [] : [{ ...frame(tick - 1, life, "death_screen"), wall_ms: wall }]),
        { ...frame(tick, life, "respawn_requested"), wall_ms: wall + 1 },
        { ...frame(tick + 1, life, "playing"), wall_ms: wall + 2 },
      ];
      await appendFile(file, frames.map(row => `${JSON.stringify(row)}\n`).join(""));
    }
    await read(receive, true);
    await read(receive, true);
    expect(ledger.summary()).toMatchObject({ deaths: 3, respawns: 3, life: 4 });
    expect(ledger.stop(600_000)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
