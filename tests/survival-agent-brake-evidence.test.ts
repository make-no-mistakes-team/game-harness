import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { verifyTerrain } from "../survival-agent/verify-terrain.ts";

const player = "127d3ae0-4132-4aac-804e-54528afce41b.json";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

type Scenario = "proved" | "still" | "not_issued" | "abstained" | "foreign" | "crossed" | "late" | "obstruction" |
  "completed" | "pickup" | "wall_limit" | "unsafe_restart";

async function readTrace(scenario: Scenario) {
  const dir = await mkdtemp(join(tmpdir(), "brake-evidence-"));
  directories.push(dir);
  const run = basename(dir);
  const requestId = "terra-1", id = "work-1", life = 1;
  const target = { kind: "stock", item: "minecraft:diamond", count: 1 } as const;
  const order = {
    v: 1, id, run, life, epoch: 1, basisTick: 10, expiresTick: 140, safetyRevision: 1, origin: "model",
    target, travelAnchor: { subject: "block:minecraft:diamond_ore", target: "m-1" },
    allowedEffects: ["break:minecraft:diamond_ore"], costCaps: [], reserves: [{ item: "minecraft:iron_pickaxe", count: 1 }],
    maxBreaks: 1, maxCrafts: 0, maxPlacements: 0,
  };
  const accepted = { v: 1, id, run, life, tick: 14, status: "accepted", detail: "Work admitted." } as const;
  const terminal = {
    ...accepted, tick: 95, status: scenario === "completed" ? "completed" : "interrupted", detail: "Work ended.",
  } as const;
  const vetoTick = scenario === "late" ? 76 : 52;
  const stopZ = scenario === "still" ? 0.6 : 3.4;
  const progress = (tick: number, z: number, neutral: boolean, owner = "work_order") => ({
    tick, wall_ms: tick * 50, goal: "diamond" as const, alive: true, life, health: 20,
    won: false, x: 0.5, y: 64, z, control_owner: owner, touching_water: false, gui: false,
    macro_grounded: true, macro_neutral: neutral, macro_cursor_clear: true,
    inventory: { "minecraft:iron_pickaxe": 1, ...(scenario === "pickup" ? { "minecraft:diamond": 1 } : {}) },
  });
  const first = progress(80, stopZ, true);
  const last = progress(100, stopZ, true);
  const steps = ["tick\twall_ms\tx\ty\tz\tyaw\tpitch\tgrounded\tsprinting\tfood\tgui\tactivity"];
  for (let tick = 2; tick <= 102; tick += 2) {
    const z = scenario === "still" ? stopZ : scenario === "crossed" && tick === 44 ? 4.1 :
      scenario === "unsafe_restart" && tick === 102 ? 3.55 :
      0.6 + Math.max(0, Math.min(2.8, (tick - 14) / 10));
    const activity = tick >= 14 && tick < vetoTick ? "Walk toward witnessed minecraft:diamond_ore" : "Holding";
    steps.push([tick, tick * 50, 0.5, 64, z, 0, 28, true, false, 20, false, activity].join("\t"));
  }
  const veto = {
    tick: vetoTick, phase: "drive", stage: scenario === "obstruction" ? "obstruction" : "surface_not_rendered",
    life, frame: 290, terminal: true, offered_ground: 0.16, braking_distance: 0.35,
    rejected_checks: scenario === "obstruction" ? ["obstruction"] : ["surface_not_rendered", "braking_distance"],
  };
  const writeJsonl = (file: string, rows: unknown[]) => writeFile(join(dir, file),
    rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await mkdir(join(dir, "server/world/stats"), { recursive: true });
  await mkdir(join(dir, "macro"));
  await Promise.all([
    writeFile(join(dir, "server/world/stats", player), JSON.stringify({ DataVersion: 4189, stats: {} })),
    writeFile(join(dir, "movement.tsv"), steps.join("\n") + "\n"),
    writeJsonl("events.jsonl", [progress(1, 0.6, true, "deterministic"), progress(14, 0.6, false), first, last]),
    writeJsonl("macro/receipts.jsonl", [
      { requestId, order, receipt: accepted, eligible: true },
      { requestId, order: scenario === "foreign" ? { ...order, travelAnchor: { ...order.travelAnchor, target: "m-2" } } : order,
        receipt: terminal, eligible: false },
    ]),
    writeJsonl("horizon.jsonl", [
      { tick: 14, phase: scenario === "not_issued" ? "preview" : "drive", stage: "issued",
        life, frame: 100, offered_ground: 1.6, braking_distance: 0.30 },
      { ...veto, tick: vetoTick - 8, frame: 250, terminal: false },
      veto,
    ]),
  ]);
  return verifyTerrain(dir, "brake-terra", last, undefined, scenario === "wall_limit" ? undefined : {
    settlement: { vetoTick, first, last },
    status: { requests: 1, providerDispatches: 1, issuedWorkOrders: scenario === "abstained" ? 0 : 1, issued: 0,
      completedWorkOrders: 0, completedWorkPrograms: 0,
      lastWorkOrder: scenario === "abstained" ? null : { requestId, id, target, origin: "model", accepted, terminal } },
  });
}

test("gap proof accepts a physical, grounded approach before a fresh support veto and neutral closure", async () => {
  expect(await readTrace("proved")).toMatchObject({
    verified: true, orderId: "work-1", issued: { tick: 14 }, edge: { z: 3.4 },
    onset: { tick: 44 }, veto: { tick: 52 }, neutral: { first: { tick: 80 }, last: { tick: 100 } },
    terminal: { status: "interrupted" },
  });
});

test.each([
  ["still", "did not approach two blocks"],
  ["not_issued", "did not physically issue"],
  ["abstained", "Missing one admitted Terra request"],
  ["foreign", "did not match"],
  ["crossed", "crossed the runway boundary"],
  ["late", "did not approach two blocks"],
  ["obstruction", "did not approach two blocks"],
  ["completed", "did not match"],
  ["pickup", "changed the resource"],
  ["wall_limit", "No pre-shutdown"],
  ["unsafe_restart", "stable neutral stop"],
] as const)("gap proof rejects %s evidence", async (scenario, reason) => {
  expect(await readTrace(scenario)).toMatchObject({ verified: false, reason: expect.stringContaining(reason) });
});
