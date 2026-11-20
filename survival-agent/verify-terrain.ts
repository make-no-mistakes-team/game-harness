import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MacroStatus } from "../src/server/survival-macro/controller.ts";
import { parseMacroReceipt, parseMacroWorkOrder } from "../src/server/survival-macro/protocol.ts";
import { terrainFixtures, type TerrainVariant } from "./diagnostic-descent.ts";
import { readSavedPlayerStats, verifySurvival } from "./verify.ts";

const sample = z.object({ tick: z.int().positive(), wall_ms: z.number(),
  x: z.number(), y: z.number(), z: z.number() });
const event = sample.extend({
  status: z.string(), health: z.number(), alive: z.boolean(),
  short_jumps: z.int().nonnegative(), headroom_cleared: z.int().nonnegative(),
  headroom_bypasses: z.int().nonnegative(), headroom_action: z.string(),
  touching_water: z.boolean().optional(), macro_grounded: z.boolean().optional(), control_owner: z.string().optional(),
  inventory: z.record(z.string(), z.int().nonnegative()),
});
const movement = sample.extend({ grounded: z.boolean(), activity: z.string() });
const blockBreak = z.object({ tick: z.int().positive(), wall_ms: z.number(), block: z.string(), held: z.string() });
type Event = z.infer<typeof event>;
type Movement = z.infer<typeof movement>;
type WadeWork = NonNullable<MacroStatus["lastWorkOrder"]>;
const driveEvidence = z.object({ tick: z.int().positive(), phase: z.string(), stage: z.string(),
  offered_ground: z.number().optional(), braking_distance: z.number().optional() });
const workEvidence = z.object({ requestId: z.string(), order: z.unknown(), receipt: z.unknown(), eligible: z.literal(true) });

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

async function proveWade(directory: string, events: Event[], steps: Movement[], breaks: z.infer<typeof blockBreak>[],
    work: WadeWork | undefined) {
  const { accepted, terminal: receipt } = work ?? {};
  if (!accepted || !receipt || receipt.status !== "completed")
    return { verified: false, reason: "Missing the single completed native stock order." };
  const { start: [sx, sy, sz], terrain: { channelZ } } = terrainFixtures["wade-terra"];
  const records = (await readFile(path.join(directory, "macro/receipts.jsonl"), "utf8")).trimEnd().split("\n")
    .map(line => workEvidence.parse(JSON.parse(line)));
  const finalOrder = parseMacroWorkOrder(records[0]?.order);
  const exactOrder = records.length === 2 && records.every((row, index) => {
    const sample = parseMacroReceipt(row.receipt);
    const expected = index === 0 ? accepted : receipt;
    return row.requestId === work?.requestId && sample.id === expected.id && sample.status === expected.status &&
      sample.run === expected.run && sample.life === expected.life && sample.tick === expected.tick;
  }) && accepted.status === "accepted" && finalOrder.id === accepted.id && finalOrder.run === path.basename(directory) &&
    finalOrder.origin === "model" &&
    finalOrder.travelAnchor?.subject === "block:minecraft:diamond_ore" &&
    finalOrder.target.kind === "stock" && finalOrder.target.item === "minecraft:diamond" && finalOrder.target.count === 1 &&
    finalOrder.allowedEffects.length === 1 && finalOrder.allowedEffects[0] === "break:minecraft:diamond_ore" &&
    finalOrder.maxBreaks === 1 && finalOrder.maxCrafts === 0 && finalOrder.maxPlacements === 0;
  const inLane = (p: Event | Movement) => Math.abs(p.x - sx) < 0.2 && Math.abs(p.y - sy) < 0.08;
  const owns = (p: Event) => p.control_owner === "work_order";
  const dry = events.find(p => p.tick <= accepted.tick && inLane(p) && Math.abs(p.z - sz) < 0.09 &&
    p.touching_water === false && p.macro_grounded === true && !(p.inventory["minecraft:diamond"] ?? 0));
  const wet = events.find(p => p.tick > accepted.tick && owns(p) && inLane(p) && p.touching_water === true &&
    p.z >= channelZ - 0.31 && p.z < channelZ + 1);
  const bank = wet && events.find(p => p.tick > wet.tick && owns(p) && inLane(p) && p.z >= channelZ + 1.27 &&
    p.touching_water === false && p.macro_grounded === true);
  const crossing = wet && bank && steps.filter(p => p.tick >= wet.tick && p.tick <= bank.tick);
  const controlled = crossing && crossing.length >= 2 && crossing.every(p => inLane(p) && p.grounded) &&
    crossing.some(p => p.z >= channelZ + 0.25 && p.z <= channelZ + 0.75);
  const cut = breaks.length === 1 && breaks[0]?.block === "minecraft:diamond_ore" ? breaks[0] : undefined;
  const pickedUp = cut && events.find(p => p.tick >= cut.tick && p.tick <= receipt.tick && owns(p) &&
    p.touching_water === false && p.macro_grounded === true && (p.inventory["minecraft:diamond"] ?? 0) === 1);
  const issued = (await readFile(path.join(directory, "horizon.jsonl"), "utf8")).trimEnd().split("\n")
    .map(line => driveEvidence.parse(JSON.parse(line))).find(p => p.phase === "drive" && p.stage === "issued" &&
      p.tick >= accepted.tick && wet && p.tick <= wet.tick && p.offered_ground !== undefined &&
      p.braking_distance !== undefined && p.offered_ground >= p.braking_distance);
  const verified = !!(exactOrder && dry && issued && wet && bank && controlled && cut && cut.tick > bank.tick && pickedUp);
  return { verified, reason: verified
    ? "An ordinary stock order drove a level dry-to-wet-to-dry crossing, then mined and collected one diamond."
    : "The trace did not prove one anchored ordinary order, a level wade to a new dry bank, and a subsequent pickup.",
    orderId: finalOrder.id, dry, issued, wet, bank, cut, pickedUp };
}

async function verifyWadeStock(statsDirectory: string, progress: unknown) {
  const live = z.object({ goal: z.literal("diamond"), alive: z.literal(true),
    inventory: z.record(z.string(), z.int().nonnegative()) }).safeParse(progress);
  const saved = await readSavedPlayerStats(statsDirectory).catch(() => null);
  const mined = saved?.stats["minecraft:mined"]?.["minecraft:diamond_ore"] ?? 0;
  const pickedUp = saved?.stats["minecraft:picked_up"]?.["minecraft:diamond"] ?? 0;
  const verified = live.success && live.data.inventory["minecraft:diamond"] === 1 && mined === 1 && pickedUp === 1;
  return { verified, mined, pickedUp, reason: verified ? "Vanilla statistics corroborate the retained diamond." :
    "Missing one retained diamond, one saved diamond ore break, or one saved diamond pickup." };
}

/** Verify the incident, not just the ordinary goal. All observations stay outside the actor. */
export async function verifyTerrain(directory: string, variant: TerrainVariant, progress: unknown, wadeWork?: WadeWork) {
  const stats = path.join(directory, "server/world/stats");
  const goal = variant === "wade-terra" ? await verifyWadeStock(stats, progress) :
    await verifySurvival(stats, terrainFixtures[variant].goal, progress);
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
      ...(variant === "wade-terra" ? await proveWade(directory, events, steps, breaks, wadeWork) :
        variant === "birch" ? proveBirch(events, steps, breaks) : proveCeiling(events, steps, breaks)) };
  } catch {
    return failed("Terrain proof artifacts were missing or unreadable.");
  }
}
