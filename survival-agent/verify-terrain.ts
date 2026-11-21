import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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

const brakeProgress = sample.extend({
  goal: z.literal("diamond"), health: z.number(), alive: z.boolean(), life: z.int().positive(), won: z.boolean(),
  control_owner: z.string(), touching_water: z.boolean(), gui: z.boolean(), macro_grounded: z.boolean(),
  macro_neutral: z.boolean(), macro_cursor_clear: z.boolean(), inventory: z.record(z.string(), z.int().nonnegative()),
});
const brakeDrive = driveEvidence.extend({
  life: z.int().positive(), frame: z.int(), terminal: z.boolean().default(false),
  rejected_checks: z.array(z.string()).default([]),
});
type BrakeProgress = z.infer<typeof brakeProgress>;
type BrakeDrive = z.infer<typeof brakeDrive>;
type BrakeSettlement = { vetoTick: number; first: BrakeProgress; last: BrakeProgress };
type BrakeWitness = { settlement: BrakeSettlement; status: Pick<MacroStatus,
  "requests" | "providerDispatches" | "issuedWorkOrders" | "issued" |
  "completedWorkOrders" | "completedWorkPrograms" | "lastWorkOrder"> | null };
const { start: [brakeX, brakeY, brakeZ], terrain: { gap: { z: [lip] } } } = terrainFixtures["brake-terra"];
const MIN_APPROACH = 2;
const NEUTRAL_TICKS = 20;
const BODY_RADIUS = 0.30;
const ORE = "minecraft:diamond_ore";
const DIAMOND = "minecraft:diamond";
const WALKING_TO_ORE = `Walk toward witnessed ${ORE}`;

function jsonLines(text: string): unknown[] {
  return text.trim() ? text.trimEnd().split("\n").map(line => JSON.parse(line)) : [];
}

function lastMatching<T>(rows: readonly T[], matches: (row: T) => boolean) {
  for (let i = rows.length - 1; i >= 0; --i) if (matches(rows[i]!)) return rows[i];
}

function onRunway(p: { x: number; y: number; z: number }) {
  return Math.abs(p.x - brakeX) <= 0.75 && Math.abs(p.y - brakeY) < 0.08 && p.z + BODY_RADIUS <= lip + 1e-6;
}

function inBrakingRegion(p: { x: number; y: number; z: number }) {
  return onRunway(p) && p.z >= brakeZ + MIN_APPROACH && p.z >= lip - 1.25;
}

function sameStance(a: { x: number; y: number; z: number }, b: typeof a) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 0.025;
}

function damageFree(p: BrakeProgress) {
  return p.alive && p.life === 1 && p.health === 20 && !p.won && !p.touching_water && !(p.inventory[DIAMOND] ?? 0);
}

function neutralAtLip(p: BrakeProgress) {
  return damageFree(p) && !p.gui && p.macro_grounded && p.macro_neutral && p.macro_cursor_clear && inBrakingRegion(p);
}

function issuedDrive(p: BrakeDrive) {
  return p.phase === "drive" && (p.stage === "issued" || p.stage === "contact_pulse_issued");
}

function citesEdgeVeto(p: BrakeDrive) {
  if (p.phase !== "drive" || p.life !== 1 || p.frame < 1 ||
      !p.rejected_checks.includes(p.stage) ||
      p.rejected_checks.some(reason => reason === "obstruction" || reason === "collision_contact")) return false;
  if (p.stage === "hazard") return true;
  if (p.offered_ground === undefined || p.braking_distance === undefined ||
      p.offered_ground < 0 || p.braking_distance <= 0) return false;
  if (p.stage === "no_new_support") return true;
  return (p.stage === "surface_not_rendered" || p.stage === "surface_height" || p.stage === "braking_distance") &&
    p.offered_ground < p.braking_distance && p.rejected_checks.includes("braking_distance") &&
    (p.rejected_checks.includes("surface_not_rendered") || p.rejected_checks.includes("surface_height"));
}

async function readBrakeDrive(directory: string) {
  const text = await readFile(path.join(directory, "horizon.jsonl"), "utf8");
  return jsonLines(text).map(row => brakeDrive.parse(row));
}

/** Find a live closure candidate; validate the complete trace again after both processes close. */
export function monitorBrakeTerrain(directory: string) {
  let first: BrakeProgress | undefined;
  let observedTick = 0;
  return async (progress: unknown): Promise<BrakeSettlement | undefined> => {
    const parsed = brakeProgress.safeParse(progress);
    if (!parsed.success || parsed.data.tick <= observedTick) return;
    const last = parsed.data;
    observedTick = last.tick;
    if (!neutralAtLip(last)) {
      first = undefined;
      return;
    }
    if (!first || !sameStance(first, last)) {
      first = last;
      return;
    }
    if (last.tick - first.tick < NEUTRAL_TICKS) return;
    const drive = await readBrakeDrive(directory).catch(() => []);
    const since = first.tick;
    const veto = lastMatching(drive, row => row.tick <= since && row.terminal && citesEdgeVeto(row));
    if (!veto || drive.some(row => issuedDrive(row) && row.tick >= veto.tick)) {
      first = last;
      return;
    }
    return { vetoTick: veto.tick, first, last };
  };
}

function parseMovement(text: string) {
  return text.trimEnd().split("\n").slice(1).map(line => {
    const [tick, wall, x, y, z, , , grounded, , , , activity] = line.split("\t");
    if (grounded !== "true" && grounded !== "false") throw new Error("Malformed grounded observation");
    return movement.parse({ tick: Number(tick), wall_ms: Number(wall), x: Number(x), y: Number(y), z: Number(z),
      grounded: grounded === "true", activity });
  });
}

async function proveBrake(directory: string, progress: unknown, witness: BrakeWitness | undefined) {
  const failed = (reason: string) => ({ verified: false, reason, diagnostic: "brake-terra" as const });
  if (!witness) return failed("No pre-shutdown braking and neutral-stop witness.");
  const { settlement: { vetoTick, first, last }, status } = witness;
  const work = status?.lastWorkOrder;
  if (!status || status.requests !== 1 || status.providerDispatches !== 1 || status.issuedWorkOrders !== 1 ||
      status.issued !== 0 || status.completedWorkOrders !== 0 || status.completedWorkPrograms !== 0 ||
      !work?.requestId || !work.accepted || !work.terminal)
    return failed("Missing one admitted Terra request and one settled native stock order without completion.");
  try {
    const read = (file: string) => readFile(path.join(directory, file), "utf8");
    const [saved, eventText, moves, breaks, drive, workText] = await Promise.all([
      readSavedPlayerStats(path.join(directory, "server/world/stats")),
      read("events.jsonl"), read("movement.tsv"), read("breaks.jsonl").catch(error => {
        if (error?.code !== "ENOENT") throw error;
        return "";
      }), readBrakeDrive(directory), read("macro/receipts.jsonl"),
    ]);
    const records = jsonLines(workText).map(row => workEvidence.extend({ eligible: z.boolean() }).parse(row));
    const opening = records[0];
    if (records.length !== 2 || !opening?.eligible) return failed("No eligible native stock acceptance was journaled.");
    const order = parseMacroWorkOrder(opening.order);
    const { accepted, terminal } = work;
    if (order.id !== work.id || order.run !== path.basename(directory) || order.life !== 1 ||
        order.origin !== "model" || work.origin !== order.origin || !isDeepStrictEqual(work.target, order.target) ||
        order.travelAnchor?.subject !== `block:${ORE}` ||
        order.target.kind !== "stock" || order.target.item !== DIAMOND || order.target.count !== 1 ||
        order.allowedEffects.length !== 1 || order.allowedEffects[0] !== `break:${ORE}` ||
        order.maxBreaks !== 1 || order.maxCrafts !== 0 || order.maxPlacements !== 0 ||
        order.costCaps.length !== 0 || order.reserves.length !== 1 ||
        order.reserves[0]!.item !== "minecraft:iron_pickaxe" || order.reserves[0]!.count !== 1 ||
        order.nextWorkId || order.duringWaitFor || order.harvestAnchor ||
        accepted.status !== "accepted" || accepted.id !== order.id || accepted.run !== order.run ||
        accepted.life !== order.life || accepted.tick < order.basisTick || accepted.tick >= vetoTick ||
        vetoTick > order.expiresTick || terminal.id !== order.id || terminal.run !== order.run ||
        terminal.life !== order.life || terminal.tick < vetoTick ||
        (terminal.status !== "refused" && terminal.status !== "interrupted") ||
        records.some((row, index) => row.requestId !== work.requestId ||
          !isDeepStrictEqual(parseMacroWorkOrder(row.order), order) ||
          !isDeepStrictEqual(parseMacroReceipt(row.receipt), index === 0 ? accepted : terminal)))
      return failed("The anchored stock order and its native acceptance and non-completion did not match.");

    const events = jsonLines(eventText).map(row => brakeProgress.parse(row));
    const final = brakeProgress.parse(progress);
    const steps = parseMovement(moves);
    if (!saved || (saved.stats["minecraft:custom"]?.["minecraft:deaths"] ?? 0) !== 0 ||
        (saved.stats["minecraft:custom"]?.["minecraft:damage_taken"] ?? 0) !== 0 ||
        (saved.stats["minecraft:mined"]?.[ORE] ?? 0) !== 0 || (saved.stats["minecraft:picked_up"]?.[DIAMOND] ?? 0) !== 0 ||
        jsonLines(breaks).length || !events.length || !events.every(p => damageFree(p) && onRunway(p)) ||
        !damageFree(final) || !onRunway(final))
      return failed("The run lacked damage-free vanilla evidence, left the runway, or changed the resource.");
    if (drive.some((row, i) => row.life !== 1 || (i > 0 && row.tick < drive[i - 1]!.tick)) ||
        events.some((row, i) => i > 0 && row.tick < events[i - 1]!.tick))
      return failed("The native journals did not describe one ordered player life.");
    if (!steps.length || !steps.every((p, i) => onRunway(p) &&
        (i === 0 ? p.tick <= 2 : p.tick > steps[i - 1]!.tick && p.tick <= steps[i - 1]!.tick + 2)))
      return failed("The physical samples crossed the runway boundary or had gaps.");
    const issued = drive.find(issuedDrive);
    const owner = issued && lastMatching(events, p => p.tick <= issued.tick);
    const launch = issued && lastMatching(steps, p => p.tick <= issued.tick);
    if (!issued || issued.stage !== "issued" || issued.life !== 1 || issued.frame < 1 ||
        issued.tick < accepted.tick || issued.tick >= vetoTick || owner?.control_owner !== "work_order" ||
        issued.offered_ground === undefined || issued.braking_distance === undefined ||
        issued.braking_distance <= 0 || issued.offered_ground < issued.braking_distance ||
        !launch || issued.tick - launch.tick > 1 || !launch.grounded ||
        Math.hypot(launch.x - brakeX, launch.y - brakeY, launch.z - brakeZ) > 0.10 ||
        steps.some(p => p.tick < issued.tick && !sameStance(p, launch)))
      return failed("The admitted order did not physically issue a supported approach from the declared start.");
    const edge = lastMatching(steps, p => p.tick <= vetoTick);
    const actualApproach = !!edge && inBrakingRegion(edge) && edge.z - launch.z >= MIN_APPROACH &&
      steps.slice(steps.indexOf(launch), steps.indexOf(edge) + 1).every((p, i, run) => {
        const previous = run[i - 1];
        return p.grounded && (!previous || (p.z + 0.025 >= previous.z &&
          (p.z - previous.z < 0.015 || p.activity === WALKING_TO_ORE || previous.activity === WALKING_TO_ORE)));
      }) &&
      events.every(p => p.tick < issued.tick || p.tick >= vetoTick || p.control_owner === "work_order");
    const veto = drive.find(p => p.tick === vetoTick && p.terminal && citesEdgeVeto(p));
    const lastIssue = lastMatching(drive, issuedDrive);
    const onset = lastIssue && drive.find(p => p.tick > lastIssue.tick && p.tick <= vetoTick &&
      p.frame > lastIssue.frame && citesEdgeVeto(p));
    const atOnset = onset && lastMatching(steps, p => p.tick <= onset.tick);
    const recentMotion = onset && steps.some((p, i) => i > 0 && p.tick <= onset.tick &&
      onset.tick - p.tick <= 8 && p.z - steps[i - 1]!.z >= 0.015);
    if (!actualApproach || !edge || vetoTick - edge.tick > 1 || !veto || !lastIssue || !recentMotion ||
        !onset || !atOnset || !inBrakingRegion(atOnset) || atOnset.z - launch.z < MIN_APPROACH ||
        veto.tick - onset.tick > 12 || lastIssue.frame >= veto.frame ||
        (veto.offered_ground !== undefined && veto.offered_ground > lip - edge.z + 0.15))
      return failed("The run did not approach two blocks before a fresh, edge-specific support veto.");
    if (first.tick < veto.tick || last.tick - first.tick < NEUTRAL_TICKS || final.tick < last.tick ||
        ![first, last, final].every(p => neutralAtLip(p) && sameStance(first, p)) ||
        !steps.some(p => p.tick >= last.tick) ||
        events.some(p => p.tick >= first.tick && (!neutralAtLip(p) || !sameStance(first, p))) ||
        !steps.every(p => p.tick < veto.tick || p.grounded && (p.tick < first.tick || sameStance(first, p))))
      return failed("The trace did not show a stable neutral stop through clean closure.");
    return { verified: true, reason: "The live stock order approached the gap, then braked and stayed on the near bank.",
      diagnostic: "brake-terra" as const, orderId: order.id, accepted, issued, launch, edge, onset, atOnset, veto,
      neutral: { first, last, final }, terminal };
  } catch {
    return failed("Gap-stop artifacts were missing or unreadable.");
  }
}

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
export async function verifyTerrain(directory: string, variant: TerrainVariant, progress: unknown, work?: WadeWork,
    brake?: BrakeWitness) {
  if (variant === "brake-terra") return proveBrake(directory, progress, brake);
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
    const steps = parseMovement(movementText);
    if (!events.length || events.some(p => !p.alive || p.health !== 20))
      return failed("Missing damage-free event history.");
    return { diagnostic: variant, goal,
      ...(variant === "wade-terra" ? await proveWade(directory, events, steps, breaks, work) :
        variant === "birch" ? proveBirch(events, steps, breaks) : proveCeiling(events, steps, breaks)) };
  } catch {
    return failed("Terrain proof artifacts were missing or unreadable.");
  }
}
