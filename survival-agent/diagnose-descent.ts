#!/usr/bin/env bun
/**
 * Parallel Multi-Scenario High-Drop & Giant-Cave Descent Diagnostic Runner.
 *
 * Completely isolated from the primary survival lane and combat diagnostics:
 * - Never touches admission.sqlite, live.json, parallel-live.json, or combat-diagnostics.
 * - Each scenario runs in its own private Xvfb display (`xvfb-run -a`), ephemeral loopback TCP port (`0`),
 *   isolated client-data directory, and output folder under
 *   local/survival-agent/descent-diagnostics/<batch>/<scenario>/ (or --out-dir / DESCENT_DIAG_OUT_DIR).
 * - Records 30fps 1280x720 screen.mp4 via ffmpeg and verifies outcomes from live agent telemetry
 *   (progress.json, events.jsonl, strategist/events.jsonl).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { JAVA, MinecraftClient } from "../src/server/minecraft-client.ts";
import { composeMacroStrategist } from "../src/server/survival-macro/strategist.ts";
import { offlineUuid, poolDiagnosticServerProperties } from "./diagnostic-pool.ts";
import { readModelSelection } from "./strategy-options.ts";

const WORKTREE_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_RUNTIME = process.env.GAMEHARNESS_DATA_DIR
  ?? path.join(WORKTREE_ROOT, "local/runtime");
const DEFAULT_OUT_ROOT = process.env.DESCENT_DIAG_OUT_DIR
  ?? path.join(WORKTREE_ROOT, "local/survival-agent/descent-diagnostics");
const AGENT_JAR = path.join(WORKTREE_ROOT, "survival-agent/build/libs/survival-agent-1.0.jar");
const SCREEN = { width: 1280, height: 720 } as const;
const SIZE = `${SCREEN.width}x${SCREEN.height}`;

interface KitItem {
  readonly item: string;
  readonly count: number;
}

interface InitialPlanDirective {
  readonly descentMethod: string;
  readonly target: string;
  readonly targetFloorY: number;
  readonly rationale: string;
}

interface ScenarioSpec {
  readonly id: string;
  readonly description: string;
  readonly startPos: readonly [number, number, number];
  readonly floorY: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly startHp: number;
  readonly startFood: number;
  readonly kit: readonly KitItem[];
  readonly terrainCommands: readonly string[];
  readonly initialPlan?: InitialPlanDirective;
  readonly usesModel?: boolean;
  readonly modelObjective?: string;
  readonly maxSeconds: number;
  readonly evaluate: (m: ScenarioMetrics) => { passed: boolean; reason: string };
}

interface ProgressSnapshot {
  tick: number;
  goal: string;
  status: string;
  won: boolean;
  alive: boolean;
  deaths?: number;
  x?: number;
  y?: number;
  z?: number;
  health?: number;
  inventory?: Record<string, number>;
  descent_method?: string;
  descent_phase?: string;
  descent_preferred?: string;
  descent_completed?: boolean;
  descent_refused?: string;
  descent_drop_depth?: number;
  descent_landing_surface?: string;
  water_clutch_landed?: boolean;
  water_reclaimed?: boolean;
  boat_dropped?: boolean;
  boat_reclaimed?: boolean;
  stair_steps_carved?: number;
  edge_blocks_placed?: number;
  fall_damage_taken?: number;
  descent_damage_taken?: number;
  damage_taken?: number;
  min_y?: number;
  max_y?: number;
}

export interface ScenarioMetrics {
  scenario: string;
  passed: boolean;
  reason: string;
  alive: boolean;
  deaths: number;
  dropHeight: number;
  startY: number;
  endY: number;
  minY: number;
  startHp: number;
  endHp: number;
  fallDamageTaken: number;
  damageTaken: number;
  methodUsed: string;
  phasesObserved: string[];
  descentCompleted: boolean;
  descentRefused: string;
  waterClutchLanded: boolean;
  waterReclaimed: boolean;
  boatDropped: boolean;
  boatReclaimed: boolean;
  stairStepsCarved: number;
  edgeBlocksPlaced: number;
  finalWaterBuckets: number;
  finalBoats: number;
  modelPlansPublished: number;
  modelPlansApplied: number;
  modelDescentMethods: string[];
  modelPlanTasks: string[];
  durationSec: number;
  videoPath: string;
  runDir: string;
}

function lanterns(coords: readonly [number, number, number][]): string[] {
  return coords.map(([x, y, z]) => `setblock ${x} ${y} ${z} minecraft:sea_lantern`);
}

/**
 * Shared realistic underground cavern shell helper:
 * Carves a dramatic multi-level stone/deepslate cavern with uneven walls, shelves,
 * rock pillars, overhangs, and bright sea-lantern lighting so footage is crisp.
 */
function carveCavernShell(
  topY: number,
  floorY: number,
  opts: { lavaFloor?: boolean; westCliffWall?: boolean; wideDeck?: boolean } = {},
): string[] {
  const cmds: string[] = [
    // Fill solid rock block surrounding the cavern volume (x:-14..14, y:floorY-2..topY+8, z:-10..18)
    `fill -14 ${floorY - 2} -10 14 ${topY + 8} 18 minecraft:stone`,
    // Natural deepslate lower strata near cavern floor
    `fill -14 ${floorY - 2} -10 14 ${floorY + 5} 18 minecraft:deepslate`,
    // Carve main giant cavern void ahead (z:1..15)
    `fill ${opts.westCliffWall ? -2 : -11} ${floorY} 1 11 ${topY + 6} 15 minecraft:air`,
    // Upper overlook alcove where player spawns (z:-6..0)
    `fill ${opts.wideDeck ? -3 : -2} ${topY} -6 ${opts.wideDeck ? 3 : 2} ${topY + 5} 0 minecraft:air`,
    // Ensure solid deck floor under spawn
    `fill ${opts.wideDeck ? -3 : -2} ${topY - 1} -6 ${opts.wideDeck ? 3 : 2} ${topY - 1} 0 minecraft:stone`,
    // Dramatic rock overhang & uneven cavern ribs on east/far walls
    `fill 7 ${floorY} 4 11 ${floorY + 3} 12 minecraft:andesite`,
    `fill 9 ${floorY + 4} 6 11 ${floorY + 9} 11 minecraft:stone`,
    `fill -11 ${floorY + 6} 10 -6 ${topY - 4} 15 minecraft:stone`,
    `fill -5 ${topY + 4} 8 6 ${topY + 6} 15 minecraft:deepslate`,
    // Natural uneven rocky ledges on outer floor edges (keeping landing zone z:1..7 clear & authentic)
    `fill -10 ${floorY} 10 -4 ${floorY + 1} 14 minecraft:cobbled_deepslate`,
    `fill 5 ${floorY} 10 10 ${floorY + 2} 14 minecraft:andesite`,
    `fill -3 ${floorY} 12 3 ${floorY} 14 minecraft:stone`,
  ];

  if (opts.lavaFloor) {
    // Deep lethal lava lake spanning the entire cavern pit floor directly below the overlook!
    cmds.push(`fill -10 ${floorY - 1} 0 10 ${floorY} 14 minecraft:lava[level=0]`);
    cmds.push(`fill -2 ${topY - 1} -6 2 ${topY - 1} 0 minecraft:stone`);
  } else {
    // Solid uneven stone/deepslate cavern floor with small natural side water/mineral accents
    cmds.push(`fill ${opts.westCliffWall ? -2 : -11} ${floorY - 1} 1 11 ${floorY - 1} 15 minecraft:deepslate`);
    cmds.push(`fill -3 ${floorY - 1} 1 3 ${floorY - 1} 7 minecraft:stone`);
    // Decorative ores embedded in distant cavern wall for visual authenticity
    cmds.push(`setblock 4 ${floorY + 1} 15 minecraft:iron_ore`);
    cmds.push(`setblock 5 ${floorY + 1} 15 minecraft:iron_ore`);
    cmds.push(`setblock -1 ${floorY + 1} 15 minecraft:deepslate_diamond_ore`);
    cmds.push(`setblock 0 ${floorY + 1} 15 minecraft:deepslate_diamond_ore`);
  }

  // Bright cavern lighting along overlook ceiling, walls, and floor perimeter
  cmds.push(...lanterns([
    [0, topY + 5, -2],
    [0, topY + 5, 4],
    [-4, topY - 4, 6],
    [5, topY - 4, 6],
    [0, floorY + 6, 15],
    [6, floorY + 4, 3],
    [0, floorY - 1, 4],
    [-2, floorY - 1, 7],
    [3, floorY - 1, 7],
    [0, floorY + 2, 15],
  ]));

  return cmds;
}

const SCENARIOS: Record<string, ScenarioSpec> = {
  water_clutch_cliff: {
    id: "water_clutch_cliff",
    description: "26-block sheer cavern cliff with water_bucket -> intentional MLG water clutch (0 fall dmg) + water reclaim",
    startPos: [0.5, 90, -1.5],
    floorY: 64,
    yaw: 0,
    pitch: 42,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:water_bucket", count: 1 },
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 16 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: carveCavernShell(90, 64),
    initialPlan: {
      descentMethod: "water_clutch",
      target: "water_clutch",
      targetFloorY: 64,
      rationale: "Execute MLG water-bucket fall clutch off the 26-block cavern cliff and reclaim water.",
    },
    maxSeconds: 55,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0
        && m.endY <= 66.5
        && m.fallDamageTaken <= 0.01
        && m.waterClutchLanded
        && (m.waterReclaimed || m.finalWaterBuckets >= 1);
      return {
        passed: ok,
        reason: ok
          ? `Nailed 26-block MLG water clutch (fallDmg=${m.fallDamageTaken}, HP=${m.endHp}, waterReclaimed=${m.waterReclaimed}, endY=${m.endY.toFixed(1)})`
          : `alive=${m.alive} endY=${m.endY.toFixed(1)} fallDmg=${m.fallDamageTaken} clutch=${m.waterClutchLanded} reclaimed=${m.waterReclaimed} buckets=${m.finalWaterBuckets}`,
      };
    },
  },

  water_pour_cavern: {
    id: "water_pour_cavern",
    description: "24-block underground cavern overlook with water_bucket -> pour waterfall at edge, ride stream safely (0 fall dmg)",
    startPos: [0.5, 88, -1.5],
    floorY: 64,
    yaw: 0,
    pitch: 38,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:water_bucket", count: 1 },
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 16 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: carveCavernShell(88, 64),
    initialPlan: {
      descentMethod: "water_pour",
      target: "water_pour",
      targetFloorY: 64,
      rationale: "Pour a reusable waterfall over the 24-block cavern lip and ride the water column safely down.",
    },
    maxSeconds: 65,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0
        && m.endY <= 66.5
        && m.fallDamageTaken <= 0.01
        && m.methodUsed === "water_pour";
      return {
        passed: ok,
        reason: ok
          ? `Poured waterfall & rode 24-block cavern descent cleanly (fallDmg=${m.fallDamageTaken}, HP=${m.endHp}, endY=${m.endY.toFixed(1)})`
          : `alive=${m.alive} endY=${m.endY.toFixed(1)} fallDmg=${m.fallDamageTaken} method=${m.methodUsed}`,
      };
    },
  },

  boat_drop_ravine: {
    id: "boat_drop_ravine",
    description: "26-block ravine drop with oak_boat -> place & mount boat, steer off ledge (0 fall dmg), dismount & recover boat",
    startPos: [0.5, 90, -2.5],
    floorY: 64,
    yaw: 0,
    pitch: 30,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:oak_boat", count: 1 },
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: carveCavernShell(90, 64, { wideDeck: true }),
    initialPlan: {
      descentMethod: "boat_drop",
      target: "boat_drop",
      targetFloorY: 64,
      rationale: "Place and mount wooden boat on the ravine ledge, drop 26 blocks with 0 fall damage, and recover boat.",
    },
    maxSeconds: 65,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0
        && m.endY <= 66.5
        && m.fallDamageTaken <= 0.01
        && m.boatDropped
        && (m.boatReclaimed || m.finalBoats >= 1);
      return {
        passed: ok,
        reason: ok
          ? `Completed 26-block boat drop & recovered boat (fallDmg=${m.fallDamageTaken}, HP=${m.endHp}, boats=${m.finalBoats}, endY=${m.endY.toFixed(1)})`
          : `alive=${m.alive} endY=${m.endY.toFixed(1)} fallDmg=${m.fallDamageTaken} dropped=${m.boatDropped} reclaimed=${m.boatReclaimed} boats=${m.finalBoats}`,
      };
    },
  },

  cliff_stair_carve: {
    id: "cliff_stair_carve",
    description: "18-block cliff into deep cave (pickaxe + cobblestone, NO water/boat) -> carves covered cliff-side staircase down",
    startPos: [0.5, 82, -1.5],
    floorY: 64,
    yaw: 0,
    pitch: 30,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 32 },
      { item: "minecraft:torch", count: 16 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: [
      ...carveCavernShell(82, 64, { westCliffWall: true }),
      // Ensure thick solid cliff wall directly west (x=-1..-10) right alongside the player's overlook!
      "fill -10 62 -6 -1 87 14 minecraft:stone",
      // Leave overlook corridor x=0..1, z=-4..0 clear so west wall at x=-1 is immediately flanking!
      "fill 0 82 -5 2 86 0 minecraft:air",
      "fill 0 81 -5 2 81 0 minecraft:stone",
      // Extra cavern lights along the cliff face
      ...lanterns([[-1, 78, 2], [-1, 72, 4], [-1, 66, 6], [1, 84, -2]]),
    ],
    initialPlan: {
      descentMethod: "cliff_stair",
      target: "cliff_stair",
      targetFloorY: 64,
      rationale: "Carve a sheltered switchback staircase inside the flanking cliff wall down to cavern floor y=64.",
    },
    maxSeconds: 110,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0
        && m.endY <= 67.0
        && m.fallDamageTaken <= 1.0
        && m.stairStepsCarved >= 6;
      return {
        passed: ok,
        reason: ok
          ? `Carved covered cliff staircase (${m.stairStepsCarved} steps, fallDmg=${m.fallDamageTaken}, HP=${m.endHp}, endY=${m.endY.toFixed(1)})`
          : `alive=${m.alive} endY=${m.endY.toFixed(1)} fallDmg=${m.fallDamageTaken} steps=${m.stairStepsCarved}`,
      };
    },
  },

  edge_block_step: {
    id: "edge_block_step",
    description: "Steep stepped cave chasm with dirt/cobblestone -> sneak edge-placement bridging & wall step-shelves to descend safely",
    startPos: [0.5, 76, -1.5],
    floorY: 64,
    yaw: 0,
    pitch: 34,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:cobblestone", count: 48 },
      { item: "minecraft:dirt", count: 32 },
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: [
      // Outer cavern enclosure
      "fill -10 62 -8 10 82 18 minecraft:stone",
      "fill -8 64 -5 8 80 15 minecraft:air",
      "fill -8 63 -5 8 63 15 minecraft:deepslate",
      // Solid western cliff wall right beside the descent column (x=-1..-8) so edge step-shelves can anchor against it!
      "fill -8 64 -5 -1 80 15 minecraft:stone",
      // Starting ledge at y=76 (z=-4..0, x=0..2)
      "fill 0 64 -4 2 75 0 minecraft:stone",
      // 3-block deep chasm at z=1..3, followed by stepped stone ledges descending toward y=64!
      // Shelf 1 at y=74 (z=4..5, x=0..3) — reachable by edge-bridging 3 blocks at y=75 then stepping down 1-2 blocks!
      "fill 0 64 4 3 73 5 minecraft:andesite",
      // Gap at z=6..7, Shelf 2 at y=71 (z=8..9, x=0..3)
      "fill 0 64 8 3 70 9 minecraft:stone",
      // Shelf 3 at y=68 (z=10..11, x=0..3)
      "fill 0 64 10 3 67 11 minecraft:cobbled_deepslate",
      // Final step at y=66 (z=12..13) down to floor y=64!
      "fill 0 64 12 3 65 13 minecraft:stone",
      ...lanterns([[0, 79, -1], [4, 77, 3], [4, 73, 7], [4, 69, 11], [0, 63, 14], [2, 63, 2], [-1, 74, 2], [-1, 70, 6]]),
    ],
    initialPlan: {
      descentMethod: "edge_blocks",
      target: "edge_blocks",
      targetFloorY: 64,
      rationale: "Use sneak edge block-placement to bridge across stepped cave ledges and descend safely to y=64.",
    },
    maxSeconds: 95,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0
        && m.endY <= 67.0
        && m.fallDamageTaken <= 0.01
        && m.edgeBlocksPlaced >= 2;
      return {
        passed: ok,
        reason: ok
          ? `Descended stepped chasm via edge blocks (placed=${m.edgeBlocksPlaced}, fallDmg=${m.fallDamageTaken}, HP=${m.endHp}, endY=${m.endY.toFixed(1)})`
          : `alive=${m.alive} endY=${m.endY.toFixed(1)} fallDmg=${m.fallDamageTaken} placed=${m.edgeBlocksPlaced}`,
      };
    },
  },

  lava_pit_refusal: {
    id: "lava_pit_refusal",
    description: "22-block drop directly over lava lake -> agent inspects floor, REFUSES water_clutch into lava, retreats & curbs safely",
    startPos: [0.5, 86, -1.5],
    floorY: 64,
    yaw: 0,
    pitch: 44,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:water_bucket", count: 1 },
      { item: "minecraft:oak_boat", count: 1 },
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 32 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: carveCavernShell(86, 64, { lavaFloor: true }),
    initialPlan: {
      // Deliberately request water_clutch to verify hard safety refusal over observed lava!
      descentMethod: "water_clutch",
      target: "water_clutch",
      targetFloorY: 64,
      rationale: "Attempt drop inspection — safety layer must refuse direct jump into observed lava lake!",
    },
    maxSeconds: 45,
    evaluate: (m) => {
      const refused = m.descentRefused === "lava_landing";
      const stayedSafe = m.minY >= 84.5 && m.damageTaken <= 0.01;
      const ok = m.alive && m.deaths === 0 && refused && stayedSafe;
      return {
        passed: ok,
        reason: ok
          ? `Correctly refused lava-pit jump (refused=${m.descentRefused}, minY=${m.minY.toFixed(1)}, dmg=${m.damageTaken}, curbBlocks=${m.edgeBlocksPlaced})`
          : `alive=${m.alive} refused='${m.descentRefused}' minY=${m.minY.toFixed(1)} dmg=${m.damageTaken}`,
      };
    },
  },

  model_descent_decision: {
    id: "model_descent_decision",
    description: "Real model strategist evaluates live cavern-overlook telemetry + inventory and chooses + executes safe descent",
    startPos: [0.5, 88, -1.5],
    floorY: 64,
    yaw: 0,
    pitch: 40,
    startHp: 20,
    startFood: 20,
    kit: [
      { item: "minecraft:water_bucket", count: 1 },
      { item: "minecraft:oak_boat", count: 1 },
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 32 },
      { item: "minecraft:cooked_beef", count: 4 },
    ],
    terrainCommands: carveCavernShell(88, 64, { wideDeck: true }),
    usesModel: true,
    modelObjective:
      "You are standing on an overlook above a deep 24-block underground cavern (floor at y=64, see state.descent). Inspect state.descent (dropDepth, floorObserved, landingSurface, landingLava, and gear: waterBucket, boat, pickaxe, scaffolds). Immediately call submit_survival_plan with replaceQueue=true, choose an appropriate descentMethod ('water_clutch', 'water_pour', 'boat_drop', or 'cliff_stair'), and queue a descend_drop task (target=your chosen method, count=64) so the player safely descends to the cavern floor with 0 fall damage!",
    maxSeconds: 85,
    evaluate: (m) => {
      const modelChose = m.modelPlansPublished >= 1 && m.modelPlansApplied >= 1 && m.modelDescentMethods.length >= 1;
      const descendedClean = m.endY <= 67.0 && m.fallDamageTaken <= 0.01;
      const ok = m.alive && m.deaths === 0 && modelChose && descendedClean;
      return {
        passed: ok,
        reason: ok
          ? `Model strategist chose [${m.modelDescentMethods.join(",")}] & executed cleanly (method=${m.methodUsed}, endY=${m.endY.toFixed(1)}, fallDmg=${m.fallDamageTaken}, HP=${m.endHp})`
          : `alive=${m.alive} plans=${m.modelPlansPublished}/${m.modelPlansApplied} methods=[${m.modelDescentMethods.join(",")}] endY=${m.endY.toFixed(1)} fallDmg=${m.fallDamageTaken}`,
      };
    },
  },
};

const ALL_SCENARIO_IDS = Object.keys(SCENARIOS);

// ===================== VANILLA NBT PLAYERDATA BUILDER =====================
const END = Buffer.from([0]);
const nbtInt = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const nbtShort = (v: number) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const nbtFloat = (v: number) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const nbtDouble = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const nbtText = (v: string) => Buffer.concat([nbtShort(v.length), Buffer.from(v, "ascii")]);
const nbtTag = (id: number, name: string, ...val: Buffer[]) => Buffer.concat([Buffer.from([id]), nbtText(name), ...val]);
const nbtList = (name: string, id: number, items: Buffer[]) =>
  nbtTag(9, name, Buffer.from([id]), nbtInt(items.length), ...items);

function buildPlayerDat(spec: ScenarioSpec): Buffer {
  return gzipSync(nbtTag(10, "",
    nbtTag(3, "DataVersion", nbtInt(4189)),
    nbtTag(8, "Dimension", nbtText("minecraft:overworld")),
    nbtTag(3, "playerGameType", nbtInt(0)),
    nbtList("Pos", 6, spec.startPos.map(nbtDouble)),
    nbtList("Motion", 6, [0, 0, 0].map(nbtDouble)),
    nbtList("Rotation", 5, [spec.yaw, spec.pitch].map(nbtFloat)),
    nbtTag(1, "OnGround", Buffer.from([1])),
    nbtTag(2, "Air", nbtShort(300)),
    nbtTag(5, "Health", nbtFloat(spec.startHp)),
    nbtTag(3, "foodLevel", nbtInt(spec.startFood)),
    nbtTag(5, "foodSaturationLevel", nbtFloat(5)),
    nbtTag(3, "SelectedItemSlot", nbtInt(0)),
    nbtList("Inventory", 10, spec.kit.map(({ item, count }, slot) => Buffer.concat([
      nbtTag(1, "Slot", Buffer.from([slot])),
      nbtTag(8, "id", nbtText(item)),
      nbtTag(3, "count", nbtInt(count)),
      END,
    ]))),
    END,
  ));
}

// ===================== PROCESS & SERVER HELPERS =====================
async function allocateLoopbackPort(): Promise<number> {
  const srv = createServer();
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = srv.address();
      srv.close((err) => {
        if (err) reject(err);
        else if (addr && typeof addr !== "string") resolve(addr.port);
        else reject(new Error("Failed to allocate loopback port."));
      });
    });
  });
}

function sendServerCommand(server: ChildProcess, cmd: string) {
  if (server.stdin?.writable) {
    server.stdin.write(`${cmd}\n`);
  }
}

async function stopProcessGroup(child: ChildProcess | undefined, gracefulCmd?: string, graceMs = 4000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (gracefulCmd && child.stdin?.writable) {
    child.stdin.write(gracefulCmd);
    const done = await Promise.race([closed.then(() => true), delay(graceMs).then(() => false)]);
    if (done) return;
  }
  const pid = child.pid;
  if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch {}
    const done = await Promise.race([closed.then(() => true), delay(3000).then(() => false)]);
    if (done) return;
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  await Promise.race([closed, delay(1500)]);
}

async function readProgress(file: string): Promise<ProgressSnapshot | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ProgressSnapshot;
  } catch {
    return null;
  }
}

function countInventoryBoats(inv?: Record<string, number>): number {
  if (!inv) return 0;
  let total = 0;
  for (const [k, v] of Object.entries(inv)) {
    if (k.endsWith("_boat") || k.endsWith("_raft")) total += v;
  }
  return total;
}

// ===================== SINGLE SCENARIO EXECUTION =====================
async function runSingleScenario(scenarioId: string, runDir: string, overrideSeconds: number | undefined, modelArg?: string) {
  const spec = SCENARIOS[scenarioId];
  if (!spec) throw new Error(`Unknown descent scenario: ${scenarioId}`);
  const display = process.env.DISPLAY;
  const authority = process.env.XAUTHORITY;
  if (!display || !authority) {
    throw new Error("--single must be launched inside its own xvfb-run -a display.");
  }

  const runtimeDir = DEFAULT_RUNTIME;
  const serverJar = path.join(runtimeDir, "minecraft/server-1.21.4.jar");
  await access(serverJar, constants.R_OK);
  await access(AGENT_JAR, constants.R_OK);
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required.");
  const java21 = "/usr/lib/jvm/java-21-openjdk-amd64/bin/java";
  const java = process.env.JAVA_HOME ? JAVA : await access(java21, constants.X_OK).then(() => java21, () => JAVA);

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const serverDir = path.join(runDir, "server");
  const serverTmp = path.join(serverDir, "tmp");
  const clientDataDir = path.join(runDir, "client-data");
  const stratDir = path.join(runDir, "strategist");
  await mkdir(serverTmp, { recursive: true, mode: 0o700 });
  await mkdir(clientDataDir, { recursive: true, mode: 0o700 });
  await mkdir(stratDir, { recursive: true, mode: 0o700 });

  const port = await allocateLoopbackPort();
  await writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  await writeFile(path.join(serverDir, "server.properties"), [
    "server-ip=127.0.0.1",
    `server-port=${port}`,
    "online-mode=false",
    "enforce-secure-profile=false",
    "gamemode=survival",
    "difficulty=normal",
    "hardcore=false",
    "level-name=world",
    "view-distance=6",
    "simulation-distance=6",
    "spawn-protection=0",
    "max-players=1",
    "log-ips=false",
    "enable-rcon=false",
    "enable-query=false",
    ...poolDiagnosticServerProperties,
    "",
  ].join("\n"));

  const ac = new AbortController();
  const signal = ac.signal;
  const videoPath = path.join(runDir, "screen.mp4");
  const progressFile = path.join(runDir, "progress.json");
  const stopMarker = path.join(runDir, `runner-stop-${path.basename(runDir)}`);

  let serverProc: ChildProcess | undefined;
  let recorderProc: ChildProcess | undefined;
  let clientProc: ChildProcess | undefined;
  let strategist: ReturnType<typeof composeMacroStrategist> | undefined;

  const startedAtMs = Date.now();
  const serverLogFd = await open(path.join(runDir, "server.log"), "w", 0o600);
  const ffmpegLogFd = await open(path.join(runDir, "ffmpeg.log"), "w", 0o600);

  const metrics: ScenarioMetrics = {
    scenario: spec.id,
    passed: false,
    reason: "not_finished",
    alive: false,
    deaths: 0,
    dropHeight: spec.startPos[1] - spec.floorY,
    startY: spec.startPos[1],
    endY: spec.startPos[1],
    minY: spec.startPos[1],
    startHp: spec.startHp,
    endHp: spec.startHp,
    fallDamageTaken: 0,
    damageTaken: 0,
    methodUsed: "none",
    phasesObserved: [],
    descentCompleted: false,
    descentRefused: "",
    waterClutchLanded: false,
    waterReclaimed: false,
    boatDropped: false,
    boatReclaimed: false,
    stairStepsCarved: 0,
    edgeBlocksPlaced: 0,
    finalWaterBuckets: 0,
    finalBoats: 0,
    modelPlansPublished: 0,
    modelPlansApplied: 0,
    modelDescentMethods: [],
    modelPlanTasks: [],
    durationSec: 0,
    videoPath,
    runDir,
  };

  try {
    // 1. Start real LLM strategist (for model_descent_decision) OR seed standard strategist plan.json!
    if (spec.usesModel) {
      if (!modelArg) throw new Error("model_descent_decision requires --model PROVIDER/MODEL.");
      const selection = readModelSelection(modelArg);
      strategist = composeMacroStrategist({
        model: selection,
        dir: runDir,
        goal: "diamond_pickaxe",
        objective: spec.modelObjective ?? "",
        authDirectory: runtimeDir,
        signal,
        maxRequests: 4,
        maxRuntimeMs: (overrideSeconds ?? spec.maxSeconds) * 1000,
        assertDisplay: () => {},
      });
      await strategist.start();
    } else if (spec.initialPlan) {
      const planWire = {
        v: 2,
        run: path.basename(runDir),
        planId: `diag-${spec.id}-1`,
        basisTick: 1,
        rationale: spec.initialPlan.rationale,
        replaceQueue: true,
        excavationMode: "safe_staircase",
        descentMethod: spec.initialPlan.descentMethod,
        tasks: [
          {
            kind: "descend_drop",
            target: spec.initialPlan.target,
            count: spec.initialPlan.targetFloorY,
            x: null,
            y: null,
            z: null,
          },
        ],
      };
      await writeFile(path.join(stratDir, "plan.json"), JSON.stringify(planWire) + "\n", { mode: 0o600 });
    }

    // 2. Start isolated vanilla 1.21.4 loopback server
    serverProc = spawn(java, [
      "-Xms384M", "-Xmx1536M", "-XX:-CreateCoredumpOnCrash",
      `-Duser.home=${serverDir}`, `-Djava.io.tmpdir=${serverTmp}`,
      "-jar", serverJar, "nogui",
    ], {
      cwd: serverDir,
      env: { ...process.env, HOME: serverDir, TMPDIR: serverTmp },
      detached: true,
      stdio: ["pipe", "pipe", serverLogFd.fd],
    });
    serverProc.on("error", () => {});
    serverProc.stdin?.on("error", () => {});

    let serverReady = false;
    let buf = "";
    serverProc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      void serverLogFd.write(chunk).catch(() => {});
      buf = (buf + text).slice(-400);
      if (/Done \([^)]+\)! For help, type "help"/.test(buf)) serverReady = true;
    });

    const serverDeadline = Date.now() + 90_000;
    while (!serverReady) {
      if (serverProc.exitCode !== null) throw new Error("Server exited before ready.");
      if (Date.now() > serverDeadline) throw new Error("Server startup timed out.");
      await delay(200);
    }

    // 3. Configure gamerules & complex cavern terrain BEFORE player joins!
    const baseCommands = [
      "gamerule doMobSpawning false",
      "gamerule doDaylightCycle false",
      "gamerule doWeatherCycle false",
      "gamerule keepInventory false",
      "gamerule doFireTick false",
      "weather clear 99999",
      "time set 6000",
      "kill @e[type=!minecraft:player]",
      `setworldspawn ${Math.floor(spec.startPos[0])} ${Math.floor(spec.startPos[1])} ${Math.floor(spec.startPos[2])}`,
      ...spec.terrainCommands,
    ];
    for (const cmd of baseCommands) {
      sendServerCommand(serverProc, cmd);
      await delay(25);
    }
    await delay(500);

    // 4. Start ffmpeg screen recorder on this scenario's private Xvfb display!
    recorderProc = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "warning", "-nostats",
      "-f", "x11grab", "-draw_mouse", "1", "-framerate", "30", "-video_size", SIZE,
      "-i", `${display}+0,0`, "-an",
      "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "24",
      "-maxrate", "3000k", "-bufsize", "3000k", "-pix_fmt", "yuv420p", "-g", "60",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      videoPath,
    ], {
      cwd: runDir,
      env: { ...process.env, DISPLAY: display, XAUTHORITY: authority },
      detached: true,
      stdio: ["pipe", "ignore", ffmpegLogFd.fd],
    });
    recorderProc.on("error", () => {});

    // 5. Stage & launch isolated Fabric 1.21.4 client with our newly built survival-agent JAR!
    const launcher = new MinecraftClient(WORKTREE_ROOT, { dataDir: clientDataDir, java });
    await launcher.stageAgentArtifact(AGENT_JAR, false);

    let playerName = "";
    const launched = await launcher.launchAgent({
      runtimeCache: runtimeDir,
      port,
      goal: "diamond_pickaxe",
      evidenceDir: runDir,
      display,
      authority,
      stillOwned: () => true,
      beforeConnect: async (profileName) => {
        playerName = profileName;
        const uuid = offlineUuid(profileName);
        const playersDir = path.join(serverDir, "world", "playerdata");
        await mkdir(playersDir, { recursive: true, mode: 0o700 });
        await writeFile(path.join(playersDir, `${uuid}.dat`), buildPlayerDat(spec), { mode: 0o600 });
      },
    }, signal);
    clientProc = launched.child;

    // 6. Wait for agent to join and report live ticks (progress.json)
    const joinDeadline = Date.now() + 90_000;
    let firstProgress: ProgressSnapshot | null = null;
    while (!firstProgress || firstProgress.tick < 5) {
      if (clientProc.exitCode !== null) throw new Error("Client exited before joining.");
      if (Date.now() > joinDeadline) throw new Error("Client join timed out.");
      firstProgress = await readProgress(progressFile);
      await delay(200);
    }

    // Ensure exact spawn orientation right after join
    sendServerCommand(serverProc, `tp ${playerName} ${spec.startPos[0]} ${spec.startPos[1]} ${spec.startPos[2]} ${spec.yaw} ${spec.pitch}`);
    await delay(150);

    // 7. Monitor descent execution until clean completion or timeout!
    const maxRunMs = (overrideSeconds ?? spec.maxSeconds) * 1000;
    const runStartMs = Date.now();
    const runDeadline = runStartMs + maxRunMs;
    const phasesSet = new Set<string>();
    let lastProg: ProgressSnapshot | null = firstProgress;
    let settleAfterDoneMs: number | null = null;

    while (Date.now() < runDeadline) {
      if (clientProc.exitCode !== null) break;
      const prog = await readProgress(progressFile);
      if (prog) {
        lastProg = prog;
        metrics.alive = prog.alive;
        metrics.deaths = prog.deaths ?? 0;
        if (typeof prog.health === "number") metrics.endHp = prog.health;
        if (typeof prog.y === "number") {
          metrics.endY = prog.y;
          metrics.minY = Math.min(metrics.minY, prog.y);
        }
        if (typeof prog.min_y === "number" && prog.min_y > -100 && prog.min_y < 400) {
          metrics.minY = Math.min(metrics.minY, prog.min_y);
        }
        if (typeof prog.fall_damage_taken === "number") metrics.fallDamageTaken = Math.max(metrics.fallDamageTaken, prog.fall_damage_taken);
        if (typeof prog.descent_damage_taken === "number")
          metrics.damageTaken = Math.max(metrics.damageTaken, prog.descent_damage_taken);
        if (prog.descent_method && prog.descent_method !== "none") metrics.methodUsed = prog.descent_method;
        if (prog.descent_phase) phasesSet.add(prog.descent_phase);
        if (prog.descent_completed) metrics.descentCompleted = true;
        if (prog.descent_refused) metrics.descentRefused = prog.descent_refused;
        if (prog.water_clutch_landed) metrics.waterClutchLanded = true;
        if (prog.water_reclaimed) metrics.waterReclaimed = true;
        if (prog.boat_dropped) metrics.boatDropped = true;
        if (prog.boat_reclaimed) metrics.boatReclaimed = true;
        if (typeof prog.stair_steps_carved === "number") metrics.stairStepsCarved = Math.max(metrics.stairStepsCarved, prog.stair_steps_carved);
        if (typeof prog.edge_blocks_placed === "number") metrics.edgeBlocksPlaced = Math.max(metrics.edgeBlocksPlaced, prog.edge_blocks_placed);
        if (prog.inventory) {
          metrics.finalWaterBuckets = prog.inventory["minecraft:water_bucket"] ?? 0;
          metrics.finalBoats = countInventoryBoats(prog.inventory);
        }

        if (!prog.alive || (prog.deaths ?? 0) > 0) break;
      }

      const elapsedMs = Date.now() - runStartMs;
      let scenarioComplete = false;
      if (spec.id === "lava_pit_refusal") {
        scenarioComplete = metrics.descentRefused === "lava_landing" && elapsedMs > 6_000;
      } else if (spec.id === "model_descent_decision") {
        const applied = strategist?.outcome().plansApplied ?? 0;
        scenarioComplete = applied >= 1 && metrics.descentCompleted && metrics.endY <= 67.0;
      } else {
        scenarioComplete = metrics.descentCompleted && metrics.endY <= 67.0;
      }

      if (scenarioComplete) {
        if (settleAfterDoneMs === null) settleAfterDoneMs = Date.now() + 2_500;
        else if (Date.now() >= settleAfterDoneMs) break;
      }

      await delay(250);
    }

    // Gracefully stop client, strategist, ffmpeg, server
    await writeFile(stopMarker, "stop\n").catch(() => {});
    await delay(1200);
    ac.abort();

    if (strategist) {
      await strategist.stop().catch(() => {});
      const out = strategist.outcome();
      metrics.modelPlansPublished = out.plansPublished;
      metrics.modelPlansApplied = out.plansApplied;
      try {
        const evText = await readFile(path.join(runDir, "strategist/events.jsonl"), "utf8");
        for (const line of evText.trim().split("\n")) {
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.event === "plan_published") {
            if (typeof ev.descentMethod === "string") metrics.modelDescentMethods.push(ev.descentMethod);
            if (Array.isArray(ev.tasks)) {
              for (const t of ev.tasks) {
                if (typeof t?.kind === "string") metrics.modelPlanTasks.push(`${t.kind}:${t.target ?? ""}`);
              }
            }
          }
        }
      } catch {}
    }

    metrics.phasesObserved = [...phasesSet];
    metrics.durationSec = Math.round((Date.now() - startedAtMs) / 100) / 10;
    if (lastProg) {
      metrics.alive = lastProg.alive && (lastProg.deaths ?? 0) === 0;
    }

    const verdict = spec.evaluate(metrics);
    metrics.passed = verdict.passed;
    metrics.reason = verdict.reason;
  } catch (err) {
    metrics.passed = false;
    metrics.reason = `error: ${err instanceof Error ? err.message : String(err)}`;
    metrics.durationSec = Math.round((Date.now() - startedAtMs) / 100) / 10;
  } finally {
    ac.abort();
    await stopProcessGroup(clientProc, undefined, 2500);
    await stopProcessGroup(recorderProc, "q", 3500);
    await stopProcessGroup(serverProc, "stop\n", 8000);
    await serverLogFd.close().catch(() => {});
    await ffmpegLogFd.close().catch(() => {});
    await writeFile(path.join(runDir, "result.json"), JSON.stringify(metrics, null, 2) + "\n", { mode: 0o600 });
  }

  console.log(JSON.stringify(metrics));
  process.exit(metrics.passed ? 0 : 1);
}

// ===================== PARALLEL ORCHESTRATOR =====================
async function runParallelBatch(
  scenarioIds: string[],
  concurrency: number,
  batchDir: string,
  overrideSeconds: number | undefined,
  modelArg?: string,
) {
  await mkdir(batchDir, { recursive: true, mode: 0o700 });
  console.log(`=== Parallel Safe-Descent Diagnostic Batch ===`);
  console.log(`Batch dir:   ${batchDir}`);
  console.log(`Scenarios:   ${scenarioIds.join(", ")}`);
  console.log(`Concurrency: ${concurrency}`);
  if (modelArg) console.log(`Model:       ${modelArg}`);
  console.log("");

  const queue = [...scenarioIds];
  const results = new Map<string, ScenarioMetrics>();

  async function runWorker(workerId: number) {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const runDir = path.join(batchDir, id);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      console.log(`[W${workerId}] Starting ${id}...`);

      const args = [
        "-a",
        "-s", `-screen 0 ${SIZE}x24`,
        "bun", import.meta.path,
        "--single", id,
        "--run-dir", runDir,
        ...(overrideSeconds ? ["--seconds", String(overrideSeconds)] : []),
        ...(modelArg ? ["--model", modelArg] : []),
      ];

      const child = spawn("xvfb-run", args, {
        cwd: WORKTREE_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

      const exitCode = await new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
      let parsed: ScenarioMetrics | undefined;
      try {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        parsed = JSON.parse(lastLine) as ScenarioMetrics;
      } catch {
        try {
          parsed = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8")) as ScenarioMetrics;
        } catch {}
      }

      if (!parsed) {
        parsed = {
          scenario: id,
          passed: false,
          reason: `worker crashed (exit=${exitCode}): ${stderr.slice(-300).trim()}`,
          alive: false,
          deaths: 0,
          dropHeight: SCENARIOS[id]?.startPos[1]! - SCENARIOS[id]?.floorY!,
          startY: SCENARIOS[id]?.startPos[1] ?? 0,
          endY: 0,
          minY: 0,
          startHp: 20,
          endHp: 0,
          fallDamageTaken: 0,
          damageTaken: 0,
          methodUsed: "none",
          phasesObserved: [],
          descentCompleted: false,
          descentRefused: "",
          waterClutchLanded: false,
          waterReclaimed: false,
          boatDropped: false,
          boatReclaimed: false,
          stairStepsCarved: 0,
          edgeBlocksPlaced: 0,
          finalWaterBuckets: 0,
          finalBoats: 0,
          modelPlansPublished: 0,
          modelPlansApplied: 0,
          modelDescentMethods: [],
          modelPlanTasks: [],
          durationSec: 0,
          videoPath: path.join(runDir, "screen.mp4"),
          runDir,
        };
      }
      results.set(id, parsed);
      const tag = parsed.passed ? "PASS" : "FAIL";
      console.log(`[W${workerId}] ${tag} ${id} (${parsed.durationSec}s) -> ${parsed.reason}`);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, scenarioIds.length) }, (_, i) => runWorker(i + 1));
  await Promise.all(workers);

  const ordered = scenarioIds.map((id) => results.get(id)!);
  const summary = {
    batchDir,
    timestamp: new Date().toISOString(),
    passedCount: ordered.filter((r) => r.passed).length,
    totalCount: ordered.length,
    results: ordered,
  };
  await writeFile(path.join(batchDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });

  console.log("\n=== Descent Diagnostic Summary ===");
  for (const r of ordered) {
    console.log(
      `${r.passed ? "PASS" : "FAIL"} | ${r.scenario.padEnd(23)} | drop=${String(r.dropHeight).padEnd(2)} | ` +
      `method=${r.methodUsed.padEnd(12)} | HP ${r.startHp}->${r.endHp} | fallDmg=${r.fallDamageTaken} | ` +
      `endY=${r.endY.toFixed(1)} | ${r.reason}`,
    );
  }
  console.log(`\nTotal: ${summary.passedCount}/${summary.totalCount} passed`);
  console.log(`Summary: ${path.join(batchDir, "summary.json")}`);
  process.exit(summary.passedCount === summary.totalCount ? 0 : 1);
}

// ===================== CLI ENTRYPOINT =====================
function parseArgs(argv: string[]) {
  const out: {
    single?: string;
    runDir?: string;
    scenarios?: string[];
    concurrency: number;
    outDir?: string;
    seconds?: number;
    model?: string;
  } = { concurrency: 3 };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--single") out.single = argv[++i];
    else if (a === "--run-dir") out.runDir = argv[++i];
    else if (a === "--scenarios") out.scenarios = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") out.concurrency = Math.max(1, Number(argv[++i]) || 2);
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--seconds") out.seconds = Math.max(10, Number(argv[++i]) || 60);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--list") {
      for (const s of Object.values(SCENARIOS)) {
        console.log(`${s.id}: ${s.description}`);
      }
      process.exit(0);
    }
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.single) {
  if (!cli.runDir) throw new Error("--single requires --run-dir");
  await runSingleScenario(cli.single, cli.runDir, cli.seconds, cli.model);
} else {
  const scenarios = cli.scenarios?.length ? cli.scenarios : ALL_SCENARIO_IDS;
  for (const id of scenarios) {
    if (!SCENARIOS[id]) throw new Error(`Unknown scenario: ${id}. Available: ${ALL_SCENARIO_IDS.join(", ")}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const batchDir = cli.outDir ?? path.join(DEFAULT_OUT_ROOT, `batch-${stamp}`);
  await runParallelBatch(scenarios, cli.concurrency, batchDir, cli.seconds, cli.model);
}
