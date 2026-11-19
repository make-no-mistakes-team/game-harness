import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { descentFixtures, type DescentVariant } from "./diagnostic-descent.ts";

const BASE_HEALTH = 20;
const OVERWORLD = "minecraft:overworld";
const SETTLE_TICKS = 20;
const GROUND_TICKS = 8;
const WATER_USE = "used the water bucket in reach; checking contact and landing";
const WATER_LANDING = "water clutch: witnessed water contact and a damage-free landing";
const CAVE_MOUTH = "cave opening: lit clearance beyond the mine and a visible rock boundary";
const CAVE_STEP = "reached cave footing and recorded the way back";
const BOAT_OFFER = "checking whether the lower ledge is broad enough for a boat";
const BOAT_MOUNT = "rowing from the witnessed ledge with a confirmed mount";
const BOAT_DROP = "descending while actually mounted in the boat";
const BOAT_LANDING = "boat descent: mounted landing without damage";
const count = z.int().nonnegative();
const observation = z.object({
  tick: count, x: z.number(), y: z.number(), z: z.number(), health: z.number(),
  alive: z.boolean(), dimension: z.literal(OVERWORLD), status: z.string(),
  water_drop_attempts: count, water_drop_landings: count, boat_attempts: count, boat_landings: count,
  cave_openings: count, cave_steps: count,
});
type Observation = z.infer<typeof observation>;

const pad = descentFixtures.water.terrain.dryLanding;
const boatPad = descentFixtures.boat.terrain.dryLanding;
const padY = pad.y;
const boatY = boatPad.y;
const waterStartY = descentFixtures.water.start[1];
const caveStartY = descentFixtures.cave.start[1];
const caveShelves = descentFixtures.cave.terrain.connectedShelves;

function onCaveShelf(p: Observation, shelf: (typeof caveShelves)[number]) {
  return p.z >= shelf.z[0] && p.z < shelf.z[1] + 1 && Math.abs(p.y - shelf.y) < 0.08;
}

function onWaterPad(x: number, y: number, z: number) {
  return Math.abs(y - padY) < 0.16 && x >= pad.x[0] && x < pad.x[1] + 1 && z >= pad.z[0] && z < pad.z[1] + 1;
}

function insideCave(x: number, y: number, z: number) {
  return x >= -4 && x < 4 && z >= 1 && z < 13 && y >= 40 && y <= 43;
}

function atBoatLanding(x: number, y: number, z: number) {
  // The passenger elevation need not exactly equal the hull's floor elevation.
  return x >= boatPad.x[0] && x < boatPad.x[1] + 1 && z >= boatPad.z[0] && z < boatPad.z[1] + 1 &&
    Math.abs(y - boatY) < 1.25;
}

function eligible(variant: DescentVariant, p: Observation) {
  if (!p.alive || p.health !== BASE_HEALTH) return false;
  if (variant === "water") return p.water_drop_attempts === 1 && p.water_drop_landings === 1 && onWaterPad(p.x, p.y, p.z);
  if (variant === "boat") return p.boat_attempts === 1 && p.boat_landings === 1 && atBoatLanding(p.x, p.y, p.z);
  return p.cave_openings >= 1 && p.cave_steps >= 2 && insideCave(p.x, p.y, p.z) &&
    p.z >= caveShelves[1].z[0] && p.y <= caveShelves[1].y;
}

/** Only observe normal progress snapshots; the agent gets neither variant nor receipt state. */
export function monitorDescent(variant: DescentVariant) {
  let candidate = -1;
  let arrived = -1;
  let last = -1;
  return (snapshot: unknown) => {
    const parsed = observation.safeParse(snapshot);
    if (!parsed.success || parsed.data.tick <= last) return null;
    const p = parsed.data;
    last = p.tick;
    if (eligible(variant, p)) {
      if (candidate < 0) candidate = last;
      if (last - candidate >= SETTLE_TICKS) return { firstTick: candidate, settledTick: last };
    } else {
      candidate = -1;
    }
    if (variant === "water" && p.y <= padY + 0.2 && arrived < 0) arrived = last;
    if (variant === "water" && arrived >= 0 && last - arrived >= 60 && p.water_drop_landings === 0)
      return "The single dry fall ended without a witnessed damage-free water clutch.";
    return null;
  };
}

type Settlement = { firstTick: number; settledTick: number };
type Sequence = { start: number; action: number; contact: number; landing: number };

async function readSequence(directory: string, variant: DescentVariant, throughTick: number): Promise<Sequence> {
  const proof = { start: 0, action: 0, contact: 0, landing: 0 };
  let mount = 0;
  const stream = createReadStream(path.join(directory, "events.jsonl"));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const p = observation.parse(JSON.parse(line));
      if (p.tick > throughTick) break;
      if (!p.alive || p.health !== BASE_HEALTH) return { start: 0, action: 0, contact: 0, landing: 0 };
      switch (variant) {
        case "water":
          if (!proof.start && p.tick === 1 && Math.abs(p.y - waterStartY) < 0.08 &&
              Math.abs(p.x - 0.5) < 0.27 && Math.abs(p.z - 0.5) < 0.27 &&
              p.water_drop_attempts === 0 && p.water_drop_landings === 0) proof.start = p.tick;
          if (proof.start && !proof.action && p.status === WATER_USE && p.water_drop_attempts === 1 &&
              p.water_drop_landings === 0 && p.y > padY + 0.35 && p.y < waterStartY - 0.5) proof.action = p.tick;
          // The production agent emits this only after observing its own still source, wet
          // contact, and eight grounded ticks without damage. Its evidence is not just a use pulse.
          if (proof.action && !proof.landing && p.status === WATER_LANDING && eligible(variant, p))
            proof.contact = proof.landing = p.tick;
          break;
        case "boat":
          if (!proof.start && p.status === CAVE_MOUTH && Math.abs(p.y - caveStartY) < 0.08) proof.start = p.tick;
          if (proof.start && !proof.action && p.status === BOAT_OFFER && Math.abs(p.y - caveStartY) < 0.08)
            proof.action = p.tick;
          if (proof.action && p.status === BOAT_MOUNT && !mount && p.boat_attempts === 0) mount = p.tick;
          if (mount && !proof.contact && p.status === BOAT_DROP && p.boat_attempts === 1 && p.boat_landings === 0 &&
              p.y < caveStartY && p.y > boatY) proof.contact = p.tick;
          // The production counter is emitted only for a still-mounted, settled, dry lower landing.
          if (proof.contact && !proof.landing && p.status === BOAT_LANDING && eligible(variant, p)) proof.landing = p.tick;
          break;
        case "cave":
          if (!proof.start && p.status === CAVE_MOUTH && Math.abs(p.y - caveStartY) < 0.08 &&
              p.z >= -2 && p.z < 1 && p.cave_openings >= 1) proof.start = p.tick;
          if (!proof.start || p.status !== CAVE_STEP || Math.abs(p.x - 0.5) >= 1.45) break;
          if (!proof.action && p.cave_steps >= 1 && onCaveShelf(p, caveShelves[0])) proof.action = p.tick;
          if (proof.action && !proof.landing && p.cave_steps >= 2 && onCaveShelf(p, caveShelves[1]))
            proof.contact = proof.landing = p.tick;
          break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return proof;
}

async function grounded(directory: string, variant: "water" | "cave", proof: Sequence, settledTick: number) {
  const stream = createReadStream(path.join(directory, "movement.tsv"));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let first = 0, last = 0;
  let supportedStart = variant === "cave";
  let lowered = false;
  try {
    for await (const row of lines) {
      const [rawTick, , rawX, rawY, rawZ, , , onGround] = row.split("\t");
      const tick = Number(rawTick), x = Number(rawX), y = Number(rawY), z = Number(rawZ);
      if (!Number.isSafeInteger(tick) || ![x, y, z].every(Number.isFinite)) continue;
      if (tick > settledTick) break;
      if (variant === "water" && tick < proof.action) {
        if (onGround === "true" && Math.abs(y - waterStartY) < 0.08 &&
            Math.abs(x - 0.5) < 0.27 && Math.abs(z - 0.5) < 0.27) supportedStart = true;
        if (supportedStart && onGround === "false" && y < waterStartY - 0.21 && y > padY + 0.35) lowered = true;
      }
      if (tick < proof.landing) continue;
      if (onGround !== "true" || (variant === "water" ? !onWaterPad(x, y, z) : !insideCave(x, y, z))) {
        first = last = 0;
        continue;
      }
      if (!first || tick - last > 2) first = tick;
      last = tick;
      if (last - first >= GROUND_TICKS) return supportedStart && (variant === "cave" || lowered);
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

const statsSchema = z.object({ stats: z.record(z.string(), z.record(z.string(), count)) });

/** Read-only corroboration after vanilla saves and closes. Never sent to the actor. */
export async function verifyDescent(directory: string, variant: DescentVariant, settlement: Settlement | null) {
  const verdict = (verified: boolean, reason: string) => ({ verified, reason, diagnostic: variant });
  if (!settlement) return verdict(false, "No live descent proof survived the settlement window.");
  try {
    const proof = await readSequence(directory, variant, settlement.settledTick);
    if (!proof.start || !proof.action || !proof.contact || !proof.landing || proof.landing > settlement.firstTick)
      return { ...verdict(false, "The production event sequence did not prove the declared descent."), proof, settlement };
    if (variant !== "boat" && !await grounded(directory, variant, proof, settlement.settledTick))
      return { ...verdict(false, "The movement trace did not show the required grounded ticks."), proof, settlement };
    const statsDir = path.join(directory, "server", "world", "stats");
    const saves = (await readdir(statsDir, { withFileTypes: true })).filter(entry => entry.isFile() &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(entry.name));
    if (saves.length !== 1) return verdict(false, "Expected one saved player in the fresh diagnostic world.");
    const { stats } = statsSchema.parse(JSON.parse(await readFile(path.join(statsDir, saves[0]!.name), "utf8")));
    const stat = (group: "custom" | "used", item: string) => stats[`minecraft:${group}`]?.[`minecraft:${item}`] ?? 0;
    const deaths = stat("custom", "deaths");
    const damageTaken = stat("custom", "damage_taken");
    const corroboration = variant === "water" ? stat("used", "water_bucket") :
      variant === "boat" ? Math.min(stat("used", "oak_boat"), stat("custom", "boat_one_cm")) :
        stat("custom", "walk_one_cm");
    const verified = deaths === 0 && damageTaken === 0 && corroboration > 0;
    return {
      ...verdict(verified, verified
        ? "Production descent evidence and saved vanilla statistics agree."
        : "Saved vanilla statistics did not corroborate an unharmed descent."),
      proof, settlement, deaths, damageTaken,
      stats: variant === "water" ? { waterBucketsUsed: stat("used", "water_bucket") } :
        variant === "boat" ? { boatsUsed: stat("used", "oak_boat"), boatCm: stat("custom", "boat_one_cm") } :
          { walkedCm: stat("custom", "walk_one_cm") },
    };
  } catch {
    return verdict(false, "Descent events, movement, or saved vanilla statistics were unavailable or unreadable.");
  }
}
