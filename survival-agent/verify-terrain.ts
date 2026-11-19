import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { terrainFixtures, type TerrainVariant } from "./diagnostic-descent.ts";
import { verifySurvival } from "./verify.ts";

const sample = z.object({ tick: z.int().positive(), wall_ms: z.number(),
  x: z.number(), y: z.number(), z: z.number() });
const event = sample.extend({
  status: z.string(), health: z.number(), alive: z.boolean(),
  short_jumps: z.int().nonnegative(), headroom_cleared: z.int().nonnegative(),
  headroom_bypasses: z.int().nonnegative(), headroom_action: z.string(),
  inventory: z.record(z.string(), z.int().nonnegative()),
});
const movement = sample.extend({ grounded: z.boolean(), activity: z.string() });
const blockBreak = z.object({ tick: z.int().positive(), wall_ms: z.number(), block: z.string(), held: z.string() });
type Event = z.infer<typeof event>;
type Movement = z.infer<typeof movement>;

function proveBirch(events: Event[], steps: Movement[], breaks: z.infer<typeof blockBreak>[]) {
  const { terrain: { upperStem: [hx, , hz], alternateStem: [ax, , az] }, start: [, sy] } = terrainFixtures.birch;
  const refused = (p: Event) => p.status === "timber unavailable: upper log outside standing reach";
  const refusals = events.filter((p, i) => refused(p) && (i === 0 || !refused(events[i - 1]!)));
  const refusal = refusals[0];
  const pickedUp = events.find(p => (p.inventory["minecraft:birch_log"] ?? 0) > 0);
  const cut = breaks.find(p => p.block === "minecraft:birch_log");
  const departed = refusal && steps.find(p => p.tick >= refusal.tick && p.z > hz + 1.25 && p.grounded);
  const nearHigh = (p: Movement) => p.z < hz + 1.25;
  const highWork = steps.some(p => nearHigh(p) &&
    (p.activity.startsWith("chopping the witnessed trunk") || p.y > sy + 0.12));
  const verified = refusals.length === 1 && refusal !== undefined && refusal.tick <= 180 &&
    Math.hypot(refusal.x - hx - 0.5, refusal.z - hz - 0.5) < 4 && Math.abs(refusal.y - sy) < 0.08 &&
    !highWork && departed !== undefined && departed.tick - refusal.tick <= 160 &&
    cut !== undefined && cut.tick > departed.tick && pickedUp !== undefined && pickedUp.tick >= cut.tick &&
    Math.hypot(pickedUp.x - ax - 0.5, pickedUp.z - az - 0.5) < 2.5;
  return { verified, reason: verified
    ? "The upper birch was refused once, followed by grounded departure and an alternate birch pickup."
    : "The trace did not prove a bounded high-birch refusal followed by an alternate birch pickup.",
    refusals: refusals.length, refusal, departed, cut, pickedUp, highWork };
}

function proveCeiling(events: Event[], steps: Movement[], breaks: z.infer<typeof blockBreak>[]) {
  const { terrain: { obstruction, exit: [x, y, z] }, start: [, sy] } = terrainFixtures.ceiling;
  const inPassage = (p: Movement | Event) => p.x > x && p.x < x + 1;
  const entered = steps.find(p => inPassage(p) && p.grounded && p.z >= 0 && p.z < 1 && Math.abs(p.y - sy) < 0.08);
  const clearing = events.find(p => p.headroom_action ===
    `headroom: clearing visible ${obstruction.join(", ")} with the best available tool`);
  const cleared = clearing && events.find(p => p.tick > clearing.tick && p.headroom_cleared === 1);
  const airborne = entered && steps.find(p => p.tick > entered.tick && inPassage(p) &&
    !p.grounded && p.y >= sy + 0.85 && p.z >= 0 && p.z < 2);
  const landed = airborne && steps.find(p => p.tick > airborne.tick && inPassage(p) &&
    p.grounded && Math.abs(p.y - y) < 0.08 && p.z >= 1 && p.z < z);
  const walked = landed && steps.find(p => p.tick > landed.tick && inPassage(p) &&
    p.grounded && !p.activity.startsWith("headroom:") && Math.abs(p.y - y) < 0.08 && p.z >= z);
  const totals = events.at(-1);
  const dirtCuts = breaks.filter(p => p.block === "minecraft:dirt");
  const dirtCut = dirtCuts[0];
  const repair = !!(clearing && cleared && airborne && dirtCuts.length === 1 && dirtCut &&
    dirtCut.tick >= clearing.tick && dirtCut.tick <= cleared.tick &&
    cleared.tick < airborne.tick && cleared.tick - clearing.tick <= 56);
  const verified = !!(entered && airborne && landed && walked && totals &&
    repair && walked.tick - entered.tick <= 130 && totals.short_jumps <= 2 && totals.headroom_bypasses === 0);
  return { verified, reason: verified
    ? "The player crossed the declared one-step overhang and continued on grounded upper footing."
    : "The trace did not prove one ceiling cut, at most two clipped jumps, and grounded passage.",
    entered, clearing, dirtCut, cleared, airborne, landed, walked,
    shortJumps: totals?.short_jumps, clearedCeilings: totals?.headroom_cleared,
    bypasses: totals?.headroom_bypasses };
}

/** Verify the incident, not just the ordinary goal. All observations stay outside the actor. */
export async function verifyTerrain(directory: string, variant: TerrainVariant, progress: unknown) {
  const goal = await verifySurvival(path.join(directory, "server/world/stats"), terrainFixtures[variant].goal, progress);
  const failed = (reason: string) => ({ verified: false, reason, diagnostic: variant, goal });
  if (!goal.verified) return failed(goal.reason);
  try {
    const [eventsText, movementText, breakText] = await Promise.all([
      readFile(path.join(directory, "events.jsonl"), "utf8"),
      readFile(path.join(directory, "movement.tsv"), "utf8"),
      readFile(path.join(directory, "breaks.jsonl"), "utf8"),
    ]);
    const events = eventsText.trimEnd().split("\n").map(line => event.parse(JSON.parse(line)));
    const breaks = breakText.trimEnd().split("\n").map(line => blockBreak.parse(JSON.parse(line)));
    const steps = movementText.trimEnd().split("\n").slice(1).map(line => {
      const [tick, wall, x, y, z, , , grounded, , , , activity] = line.split("\t");
      if (grounded !== "true" && grounded !== "false") throw new Error("Malformed grounded observation");
      return movement.parse({ tick: Number(tick), wall_ms: Number(wall), x: Number(x), y: Number(y), z: Number(z),
        grounded: grounded === "true", activity });
    });
    if (!events.length || events.some(p => !p.alive || p.health !== 20))
      return failed("Missing damage-free event history.");
    return { diagnostic: variant, goal,
      ...(variant === "birch" ? proveBirch(events, steps, breaks) : proveCeiling(events, steps, breaks)) };
  } catch {
    return failed("Terrain events or movement were unavailable or unreadable.");
  }
}
