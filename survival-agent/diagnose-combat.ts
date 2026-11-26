#!/usr/bin/env bun
/**
 * Parallel Multi-Scenario Complex-Terrain Combat Diagnostic Runner.
 *
 * Completely isolated from the primary survival lane:
 * - Never touches admission.sqlite, live.json, parallel-live.json, or diagnostic-live.json.
 * - Each scenario runs in its own private Xvfb display, ephemeral loopback TCP port,
 *   isolated client-data directory, and output folder under
 *   local/survival-agent/combat-diagnostics/<batch>/<scenario>/ (or --out-dir).
 * - Records 30fps 1280x720 screen.mp4 via ffmpeg and verifies outcomes from both
 *   live agent telemetry (progress.json, events.jsonl) and server ground-truth entity checks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
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
const DEFAULT_OUT_ROOT = process.env.COMBAT_DIAG_OUT_DIR
  ?? path.join(WORKTREE_ROOT, "local/survival-agent/combat-diagnostics");
const AGENT_JAR = path.join(WORKTREE_ROOT, "survival-agent/build/libs/survival-agent-1.0.jar");
const SCREEN = { width: 1280, height: 720 } as const;
const SIZE = `${SCREEN.width}x${SCREEN.height}`;

interface KitItem {
  readonly item: string;
  readonly count: number;
}

interface ScenarioSpec {
  readonly id: string;
  readonly description: string;
  readonly startPos: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly startHp: number;
  readonly startFood: number;
  readonly startSaturation: number;
  readonly kit: readonly KitItem[];
  readonly terrainCommands: readonly string[];
  readonly summonCommands: readonly string[];
  readonly initialMobCount: number;
  readonly maxSeconds: number;
  readonly usesModel?: boolean;
  readonly modelObjective?: string;
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
  food?: number;
  combat_stance?: string;
  combat_action?: string;
  shield_equipped?: boolean;
  blocking?: boolean;
  shield_blocks?: number;
  shield_blocking_ticks?: number;
  damage_taken?: number;
  in_shelter?: boolean;
  shelter_sealed?: boolean;
  shelter_roofed?: boolean;
  shelter_ever_sealed?: boolean;
  shelter_ever_roofed?: boolean;
  shelter_blocks_placed?: number;
  trapped?: boolean;
  visible_hostiles?: number;
  occluded_hostiles?: number;
  mobs_killed?: number;
}

export interface ScenarioMetrics {
  scenario: string;
  passed: boolean;
  reason: string;
  alive: boolean;
  deaths: number;
  startHp: number;
  endHp: number;
  minHp: number;
  maxHpAfterShelter: number;
  startFood: number;
  endFood: number;
  minY: number;
  damageTaken: number;
  initialMobs: number;
  mobsRemaining: number;
  mobsKilledServer: number;
  mobsKilledObserved: number;
  shieldEquippedEver: boolean;
  shieldBlocks: number;
  shieldBlockingTicks: number;
  shelterEverSealed: boolean;
  shelterEverRoofed: boolean;
  shelterBlocksPlaced: number;
  combatStancesObserved: string[];
  combatActionsObserved: string[];
  modelPlansPublished: number;
  modelPlansApplied: number;
  modelPlanStances: string[];
  modelPlanTasks: string[];
  durationSec: number;
  videoPath: string;
  runDir: string;
}

// Helper for arena lighting so night recordings are bright, crisp, and inspectable
function arenaLanterns(coords: readonly [number, number, number][]): string[] {
  return coords.map(([x, y, z]) => `setblock ${x} ${y} ${z} minecraft:sea_lantern`);
}

function oakTree(x: number, y: number, z: number): string[] {
  return [
    `fill ${x} ${y} ${z} ${x} ${y + 4} ${z} minecraft:oak_log`,
    `fill ${x - 2} ${y + 3} ${z - 2} ${x + 2} ${y + 4} ${z + 2} minecraft:oak_leaves[persistent=true] replace minecraft:air`,
    `fill ${x - 1} ${y + 5} ${z - 1} ${x + 1} ${y + 5} ${z + 1} minecraft:oak_leaves[persistent=true] replace minecraft:air`,
  ];
}

const SCENARIOS: Record<string, ScenarioSpec> = {
  zombie_uneven: {
    id: "zombie_uneven",
    description: "Zombie on uneven wooded hillside with boulders & trees (sight occlusion)",
    startPos: [0.5, 64, -3.5],
    yaw: 0,
    pitch: 4,
    startHp: 20,
    startFood: 20,
    startSaturation: 5,
    kit: [
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:cooked_beef", count: 4 },
      { item: "minecraft:cobblestone", count: 16 },
    ],
    terrainCommands: [
      // Perimeter retaining walls (enclosed 28x28 wooded arena)
      "fill -14 63 -14 14 63 14 minecraft:grass_block",
      "fill -14 64 -14 14 68 -14 minecraft:cobblestone",
      "fill -14 64 14 14 68 14 minecraft:cobblestone",
      "fill -14 64 -14 -14 68 14 minecraft:cobblestone",
      "fill 14 64 -14 14 68 14 minecraft:cobblestone",
      // Terraced hillside elevation steps
      "fill -12 64 4 12 64 13 minecraft:dirt",
      "fill -12 65 4 12 65 13 minecraft:grass_block",
      "fill -12 65 9 12 65 13 minecraft:stone",
      "fill -12 66 9 12 66 13 minecraft:grass_block",
      "fill -10 64 -10 -4 64 -4 minecraft:grass_block",
      "fill 5 64 -9 11 64 -3 minecraft:grass_block",
      // Boulders for occlusion
      "fill -2 64 2 -1 65 3 minecraft:cobblestone",
      "fill 3 64 0 4 66 1 minecraft:stone",
      "fill -4 64 -2 -3 65 -1 minecraft:mossy_cobblestone",
      // Trees for wooded cover & sight occlusion
      ...oakTree(-6, 65, 5),
      ...oakTree(6, 65, 6),
      ...oakTree(-7, 65, -7),
      ...oakTree(7, 65, -6),
      ...arenaLanterns([[-8, 63, -8], [8, 63, -8], [0, 63, 0], [-8, 65, 8], [8, 65, 8], [0, 65, 5]]),
    ],
    summonCommands: [
      'summon minecraft:zombie 1.5 66 6.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
    ],
    initialMobCount: 1,
    maxSeconds: 65,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0 && m.mobsRemaining === 0 && m.endHp >= 8;
      return {
        passed: ok,
        reason: ok
          ? `Killed zombie cleanly (HP ${m.startHp}->${m.endHp})`
          : `alive=${m.alive} deaths=${m.deaths} rem=${m.mobsRemaining} endHp=${m.endHp}`,
      };
    },
  },

  baby_zombie_obstacles: {
    id: "baby_zombie_obstacles",
    description: "Fast baby zombie in obstructed stone-pillar ruins",
    startPos: [0.5, 64, -4.5],
    yaw: 0,
    pitch: 8,
    startHp: 20,
    startFood: 20,
    startSaturation: 5,
    kit: [
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:shield", count: 1 },
      { item: "minecraft:cooked_beef", count: 6 },
      { item: "minecraft:cobblestone", count: 16 },
    ],
    terrainCommands: [
      "fill -12 63 -12 12 63 12 minecraft:stone_bricks",
      "fill -12 64 -12 12 68 -12 minecraft:stone_bricks",
      "fill -12 64 12 12 68 12 minecraft:stone_bricks",
      "fill -12 64 -12 -12 68 12 minecraft:stone_bricks",
      "fill 12 64 -12 12 68 12 minecraft:stone_bricks",
      // Uneven ledges & obstacles
      "fill -9 64 2 -4 64 8 minecraft:cobblestone",
      "fill 4 64 -2 9 64 5 minecraft:cobblestone",
      "fill -2 64 6 2 64 8 minecraft:stone_bricks",
      // 6 vertical ruin pillars creating real LOS breaks
      "fill -3 64 0 -3 66 0 minecraft:chiseled_stone_bricks",
      "fill 3 64 0 3 66 0 minecraft:chiseled_stone_bricks",
      "fill -2 64 4 -2 66 4 minecraft:chiseled_stone_bricks",
      "fill 2 64 4 2 66 4 minecraft:chiseled_stone_bricks",
      "fill 0 64 -1 0 65 -1 minecraft:mossy_stone_bricks",
      "fill -5 64 -5 -5 66 -5 minecraft:chiseled_stone_bricks",
      ...arenaLanterns([[-6, 63, -6], [6, 63, -6], [0, 63, 2], [-6, 64, 6], [6, 63, 6], [0, 63, -5]]),
    ],
    summonCommands: [
      'summon minecraft:zombie 1.5 64 5.5 {IsBaby:1b,PersistenceRequired:1b,Tags:["diag_mob"]}',
    ],
    initialMobCount: 1,
    maxSeconds: 65,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0 && (m.mobsRemaining === 0 || m.shelterEverSealed);
      return {
        passed: ok,
        reason: ok
          ? (m.mobsRemaining === 0
              ? `Defeated baby zombie cleanly (HP ${m.startHp}->${m.endHp})`
              : `Survived baby zombie via sealed shelter (HP ${m.startHp}->${m.endHp})`)
          : `alive=${m.alive} deaths=${m.deaths} rem=${m.mobsRemaining} sealed=${m.shelterEverSealed}`,
      };
    },
  },

  creeper_ledge: {
    id: "creeper_ledge",
    description: "Creeper near a 10-block cliff drop-off and boulder wall (combat-flow geometry test)",
    startPos: [0.5, 64, 0.5],
    yaw: 0,
    pitch: 5,
    startHp: 20,
    startFood: 20,
    startSaturation: 5,
    kit: [
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:shield", count: 1 },
      { item: "minecraft:cooked_beef", count: 4 },
      { item: "minecraft:cobblestone", count: 16 },
    ],
    terrainCommands: [
      // Safe plateau x:-9..7, z:-2..12 at y=63, surrounded by walls on outer boundary
      "fill -14 53 -14 14 68 14 minecraft:air",
      "fill -14 52 -14 14 52 14 minecraft:stone",
      // Outer boundary walls at chasm bottom
      "fill -14 53 -14 14 68 -14 minecraft:cobblestone",
      "fill -14 53 14 14 68 14 minecraft:cobblestone",
      "fill -14 53 -14 -14 68 14 minecraft:cobblestone",
      "fill 14 53 -14 14 68 14 minecraft:cobblestone",
      // Elevated cliff plateau (y=63 top; steep 10-block drop-off to north z<=-3 and east x>=8!)
      "fill -10 53 -2 7 62 12 minecraft:stone",
      "fill -10 63 -2 7 63 12 minecraft:grass_block",
      // Boulder/wall on the west edge & uneven rock steps on plateau
      "fill -10 64 -2 -9 66 12 minecraft:cobblestone",
      "fill -5 64 4 -4 65 5 minecraft:stone",
      "fill 3 64 8 5 64 10 minecraft:cobblestone",
      ...arenaLanterns([[-6, 63, 1], [4, 63, 1], [0, 63, 6], [-6, 63, 9], [5, 63, 10], [0, 52, -7]]),
    ],
    summonCommands: [
      'summon minecraft:creeper 0.5 64 7.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
    ],
    initialMobCount: 1,
    maxSeconds: 65,
    evaluate: (m) => {
      const noCliffFall = m.minY >= 61.5;
      const ok = m.alive && m.deaths === 0 && noCliffFall && (m.mobsRemaining === 0 || m.endHp >= 10);
      return {
        passed: ok,
        reason: ok
          ? `Handled creeper on cliff without falling (minY=${m.minY.toFixed(1)}, rem=${m.mobsRemaining}, HP=${m.endHp})`
          : `alive=${m.alive} minY=${m.minY.toFixed(1)} rem=${m.mobsRemaining} endHp=${m.endHp}`,
      };
    },
  },

  skeleton_shield_cover: {
    id: "skeleton_shield_cover",
    description: "Skeleton archer across courtyard with cover pillars (shield equip + block + kill)",
    startPos: [0.5, 64, -6.5],
    yaw: 0,
    pitch: 3,
    startHp: 20,
    startFood: 20,
    startSaturation: 5,
    kit: [
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:shield", count: 1 },
      { item: "minecraft:cooked_beef", count: 4 },
      { item: "minecraft:cobblestone", count: 12 },
    ],
    terrainCommands: [
      "fill -11 63 -11 11 63 11 minecraft:cobblestone",
      "fill -11 64 -11 11 68 -11 minecraft:stone_bricks",
      "fill -11 64 11 11 68 11 minecraft:stone_bricks",
      "fill -11 64 -11 -11 68 11 minecraft:stone_bricks",
      "fill 11 64 -11 11 68 11 minecraft:stone_bricks",
      // 4 cover pillars + slight elevation steps
      "fill -3 64 -2 -3 66 -2 minecraft:stone_bricks",
      "fill 3 64 -2 3 66 -2 minecraft:stone_bricks",
      "fill -4 64 3 -4 66 3 minecraft:stone_bricks",
      "fill 4 64 3 4 66 3 minecraft:stone_bricks",
      "fill -2 64 5 2 64 8 minecraft:cobblestone",
      ...arenaLanterns([[-6, 63, -6], [6, 63, -6], [0, 63, 0], [-6, 63, 6], [6, 63, 6], [0, 64, 6]]),
    ],
    summonCommands: [
      'summon minecraft:skeleton 0.5 65 6.5 {PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}],Tags:["diag_mob"]}',
    ],
    initialMobCount: 1,
    maxSeconds: 65,
    evaluate: (m) => {
      const usedShield = m.shieldEquippedEver && (m.shieldBlockingTicks > 0 || m.shieldBlocks > 0);
      const ok = m.alive && m.deaths === 0 && usedShield && m.mobsRemaining === 0;
      return {
        passed: ok,
        reason: ok
          ? `Equipped & raised shield (${m.shieldBlocks} blocks, ${m.shieldBlockingTicks}t blocking) and killed skeleton (HP=${m.endHp})`
          : `alive=${m.alive} shieldEq=${m.shieldEquippedEver} blocks=${m.shieldBlocks} blockTicks=${m.shieldBlockingTicks} rem=${m.mobsRemaining}`,
      };
    },
  },

  spider_mixed_terrain: {
    id: "spider_mixed_terrain",
    description: "Hostile night spider on uneven forested ridge with boulders",
    startPos: [0.5, 64, -4.5],
    yaw: 0,
    pitch: 4,
    startHp: 20,
    startFood: 20,
    startSaturation: 5,
    kit: [
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:shield", count: 1 },
      { item: "minecraft:cooked_beef", count: 4 },
      { item: "minecraft:cobblestone", count: 16 },
    ],
    terrainCommands: [
      "fill -12 63 -12 12 63 12 minecraft:grass_block",
      "fill -12 64 -12 12 68 -12 minecraft:cobblestone",
      "fill -12 64 12 12 68 12 minecraft:cobblestone",
      "fill -12 64 -12 -12 68 12 minecraft:cobblestone",
      "fill 12 64 -12 12 68 12 minecraft:cobblestone",
      // Uneven ridge + boulders + trees
      "fill -10 64 2 10 64 10 minecraft:dirt",
      "fill -10 65 2 10 65 10 minecraft:grass_block",
      "fill -6 66 5 6 66 10 minecraft:stone",
      "fill -3 64 -1 -2 65 0 minecraft:cobblestone",
      "fill 3 64 0 4 65 1 minecraft:cobblestone",
      ...oakTree(-7, 66, 6),
      ...oakTree(7, 66, 6),
      ...arenaLanterns([[-7, 63, -7], [7, 63, -7], [0, 63, -2], [-4, 66, 7], [4, 66, 7]]),
    ],
    summonCommands: [
      'summon minecraft:spider 0.5 67 6.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
    ],
    initialMobCount: 1,
    maxSeconds: 65,
    evaluate: (m) => {
      const ok = m.alive && m.deaths === 0 && (m.mobsRemaining === 0 || (m.shelterEverSealed && m.shelterEverRoofed));
      return {
        passed: ok,
        reason: ok
          ? (m.mobsRemaining === 0
              ? `Killed spider on uneven terrain (HP ${m.startHp}->${m.endHp})`
              : `Built fully-roofed spider-proof shelter (HP ${m.startHp}->${m.endHp})`)
          : `alive=${m.alive} rem=${m.mobsRemaining} roofed=${m.shelterEverRoofed}`,
      };
    },
  },

  multi_mob_swarm: {
    id: "multi_mob_swarm",
    description: "3 simultaneous hostiles (zombie + skeleton + creeper) on terraced ruins with cliff edge",
    startPos: [0.5, 64, -1.5],
    yaw: 0,
    pitch: 4,
    startHp: 20,
    startFood: 20,
    startSaturation: 5,
    kit: [
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:shield", count: 1 },
      { item: "minecraft:cooked_beef", count: 6 },
      { item: "minecraft:cobblestone", count: 24 },
      { item: "minecraft:stone_pickaxe", count: 1 },
    ],
    terrainCommands: [
      // Chasm on the north edge (z <= -5) so agent must respect cliff while fighting 3 mobs!
      "fill -14 54 -14 14 68 14 minecraft:air",
      "fill -14 53 -14 14 53 14 minecraft:stone",
      "fill -14 54 -14 14 68 -14 minecraft:cobblestone",
      "fill -14 54 14 14 68 14 minecraft:cobblestone",
      "fill -14 54 -14 -14 68 14 minecraft:cobblestone",
      "fill 14 54 -14 14 68 14 minecraft:cobblestone",
      // Main ruins plateau z=-4..13, x=-13..13
      "fill -13 54 -4 13 62 13 minecraft:stone",
      "fill -13 63 -4 13 63 13 minecraft:stone_bricks",
      // Ruins cover pillars & uneven steps
      "fill -4 64 2 -4 66 2 minecraft:cobblestone",
      "fill 4 64 2 4 66 2 minecraft:cobblestone",
      "fill 0 64 5 0 66 5 minecraft:cobblestone",
      "fill -8 64 6 -5 64 11 minecraft:cobblestone",
      "fill 6 64 5 10 64 10 minecraft:cobblestone",
      ...arenaLanterns([[-7, 63, -2], [7, 63, -2], [0, 63, 1], [-7, 64, 8], [7, 64, 8], [0, 63, 9]]),
    ],
    summonCommands: [
      'summon minecraft:zombie -3.5 64 7.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
      'summon minecraft:skeleton 4.5 64 8.5 {PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}],Tags:["diag_mob"]}',
      'summon minecraft:creeper 0.5 64 10.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
    ],
    initialMobCount: 3,
    maxSeconds: 85,
    evaluate: (m) => {
      const noCliffFall = m.minY >= 61.5;
      const strongOutcome = m.mobsKilledServer >= 2 || (m.shelterEverSealed && m.shelterEverRoofed);
      const ok = m.alive && m.deaths === 0 && noCliffFall && strongOutcome;
      return {
        passed: ok,
        reason: ok
          ? `Survived 3-mob swarm (killed ${m.mobsKilledServer}/${m.initialMobs}, shieldBlocks=${m.shieldBlocks}, sealed=${m.shelterEverSealed}, minY=${m.minY.toFixed(1)}, HP=${m.endHp})`
          : `alive=${m.alive} minY=${m.minY.toFixed(1)} killed=${m.mobsKilledServer}/${m.initialMobs} sealed=${m.shelterEverSealed}`,
      };
    },
  },

  trapped_flee_shelter: {
    id: "trapped_flee_shelter",
    description: "Low-HP (8 HP) under-equipped agent trapped in dead-end ravine with 3 hostiles pursuing -> emergency roofed shelter + heal",
    startPos: [0.5, 64, -1.5],
    yaw: 0,
    pitch: 5,
    startHp: 8,
    startFood: 14,
    startSaturation: 0,
    kit: [
      { item: "minecraft:wooden_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 24 },
      { item: "minecraft:dirt", count: 16 },
      { item: "minecraft:cooked_beef", count: 6 },
    ],
    terrainCommands: [
      "fill -12 63 -12 12 63 12 minecraft:stone",
      // Deep dead-end stone canyon/ravine: open only toward south (z=+3..+12), walled on W (x<=-2), E (x>=2), N (z<=-3)!
      "fill -10 64 -10 10 69 12 minecraft:stone",
      // Carve narrow canyon interior: x=-1..1, y=64..69, z=-2..11
      "fill -1 64 -2 1 69 11 minecraft:air",
      // Wider mouth where mobs approach: x=-4..4, z=5..11
      "fill -4 64 5 4 69 11 minecraft:air",
      // Cap back outer wall cleanly & light the ravine well
      ...arenaLanterns([[0, 63, -2], [0, 63, 2], [-2, 65, 0], [2, 65, 0], [0, 63, 7], [-3, 63, 9], [3, 63, 9]]),
    ],
    summonCommands: [
      'summon minecraft:zombie -0.5 64 6.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
      'summon minecraft:zombie 1.5 64 8.0 {PersistenceRequired:1b,Tags:["diag_mob"]}',
      'summon minecraft:skeleton 0.5 64 9.5 {PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}],Tags:["diag_mob"]}',
    ],
    initialMobCount: 3,
    maxSeconds: 60,
    evaluate: (m) => {
      const healed = m.maxHpAfterShelter > m.startHp + 0.5 || m.endHp > m.startHp + 0.5;
      const ok = m.alive && m.deaths === 0 && m.shelterEverSealed && m.shelterEverRoofed && healed;
      return {
        passed: ok,
        reason: ok
          ? `Built sealed roofed shelter (${m.shelterBlocksPlaced} blocks), ate & healed (HP ${m.startHp}->max ${m.maxHpAfterShelter}/end ${m.endHp})`
          : `alive=${m.alive} sealed=${m.shelterEverSealed} roofed=${m.shelterEverRoofed} blocks=${m.shelterBlocksPlaced} HP=${m.startHp}->${m.maxHpAfterShelter}/${m.endHp}`,
      };
    },
  },

  model_combat_decision: {
    id: "model_combat_decision",
    description: "Real model strategist governs fight vs flee/shelter response during live low-HP mixed-mob ambush",
    startPos: [0.5, 64, -2.5],
    yaw: 0,
    pitch: 5,
    startHp: 10,
    startFood: 14,
    startSaturation: 0,
    kit: [
      { item: "minecraft:stone_sword", count: 1 },
      { item: "minecraft:wooden_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 24 },
      { item: "minecraft:cooked_beef", count: 6 },
    ],
    terrainCommands: [
      "fill -12 63 -12 12 63 12 minecraft:cobblestone",
      "fill -12 64 -12 12 68 -12 minecraft:stone_bricks",
      "fill -12 64 12 12 68 12 minecraft:stone_bricks",
      "fill -12 64 -12 -12 68 12 minecraft:stone_bricks",
      "fill 12 64 -12 12 68 12 minecraft:stone_bricks",
      // Rocky ravine-like ruins with alcoves & cover pillars
      "fill -4 64 -6 -4 67 2 minecraft:stone",
      "fill 4 64 -6 4 67 2 minecraft:stone",
      "fill -4 64 -6 4 67 -6 minecraft:stone",
      "fill -2 64 4 -2 66 4 minecraft:cobblestone",
      "fill 2 64 4 2 66 4 minecraft:cobblestone",
      ...arenaLanterns([[0, 63, -3], [0, 63, 2], [-3, 63, 7], [3, 63, 7], [0, 63, 9]]),
    ],
    summonCommands: [
      'summon minecraft:zombie -1.5 64 7.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
      'summon minecraft:zombie 1.5 64 8.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
      'summon minecraft:skeleton 0.5 64 10.0 {PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}],Tags:["diag_mob"]}',
      'summon minecraft:creeper -2.5 64 10.5 {PersistenceRequired:1b,Tags:["diag_mob"]}',
    ],
    initialMobCount: 4,
    maxSeconds: 75,
    usesModel: true,
    modelObjective:
      "You are ambushed by 4 mixed hostiles (2 zombies, skeleton, creeper) while injured (10 HP) without a shield or armor. Inspect state.combat and immediately issue a submit_survival_plan with combatStance='shelter' (and replaceQueue=true, build_shelter task) or tactical defense/flee so the player survives and heals!",
    evaluate: (m) => {
      const modelGoverned = m.modelPlansPublished >= 1 && m.modelPlansApplied >= 1 && m.modelPlanStances.length >= 1;
      const ok = m.alive && m.deaths === 0 && modelGoverned;
      return {
        passed: ok,
        reason: ok
          ? `Model strategist applied ${m.modelPlansApplied} plan(s) [stances=${m.modelPlanStances.join(",")}, tasks=${m.modelPlanTasks.join(",")}]; agent survived (HP=${m.endHp}, sealed=${m.shelterEverSealed})`
          : `alive=${m.alive} published=${m.modelPlansPublished} applied=${m.modelPlansApplied} stances=${m.modelPlanStances.join(",")}`,
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
    nbtTag(5, "foodSaturationLevel", nbtFloat(spec.startSaturation)),
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

function sendServerCommand(server: ChildProcess, cmd: string): void {
  if (server.stdin?.writable) {
    server.stdin.write(`${cmd}\n`);
  }
}

async function queryTaggedMobCount(server: ChildProcess, tag = "diag_mob"): Promise<number | null> {
  const { stdin, stdout } = server;
  if (!stdin?.writable || !stdout?.readable) return null;
  return new Promise<number | null>((resolve) => {
    let tail = "";
    const finish = (val: number | null) => {
      clearTimeout(timer);
      stdout.off("data", onData);
      resolve(val);
    };
    const onData = (chunk: Buffer) => {
      const lines = (tail + chunk.toString("utf8")).split("\n");
      tail = lines.pop()!.slice(-1024);
      for (const line of lines) {
        const msg = line.match(/^\[[^\]]+\] \[Server thread\/INFO\]: (.*)$/)?.[1]?.trim();
        if (!msg) continue;
        const mCount = msg.match(/^Test passed, count: (\d+)$/);
        if (mCount) { finish(Number(mCount[1])); return; }
        if (msg === "Test passed") { finish(1); return; }
        if (msg === "Test failed") { finish(0); return; }
      }
    };
    const timer = setTimeout(() => finish(null), 1500);
    stdout.on("data", onData);
    stdin.write(`execute if entity @e[tag=${tag}]\n`, (err) => { if (err) finish(null); });
  });
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

// ===================== SINGLE SCENARIO EXECUTION =====================
async function runSingleScenario(scenarioId: string, runDir: string, overrideSeconds: number | undefined, modelArg?: string) {
  const spec = SCENARIOS[scenarioId];
  if (!spec) throw new Error(`Unknown combat scenario: ${scenarioId}`);
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
  await mkdir(serverTmp, { recursive: true, mode: 0o700 });
  await mkdir(clientDataDir, { recursive: true, mode: 0o700 });

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

  let metrics: ScenarioMetrics = {
    scenario: spec.id,
    passed: false,
    reason: "incomplete",
    alive: false,
    deaths: 0,
    startHp: spec.startHp,
    endHp: 0,
    minHp: spec.startHp,
    maxHpAfterShelter: 0,
    startFood: spec.startFood,
    endFood: spec.startFood,
    minY: spec.startPos[1],
    damageTaken: 0,
    initialMobs: spec.initialMobCount,
    mobsRemaining: spec.initialMobCount,
    mobsKilledServer: 0,
    mobsKilledObserved: 0,
    shieldEquippedEver: false,
    shieldBlocks: 0,
    shieldBlockingTicks: 0,
    shelterEverSealed: false,
    shelterEverRoofed: false,
    shelterBlocksPlaced: 0,
    combatStancesObserved: [],
    combatActionsObserved: [],
    modelPlansPublished: 0,
    modelPlansApplied: 0,
    modelPlanStances: [],
    modelPlanTasks: [],
    durationSec: 0,
    videoPath,
    runDir,
  };

  try {
    // 1. Optionally start async model strategist before client joins so auth is already warm!
    if (spec.usesModel) {
      if (!modelArg) throw new Error(`Scenario ${spec.id} requires --model PROVIDER/MODEL.`);
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

    // 3. Configure gamerules & complex terrain BEFORE player joins!
    const baseCommands = [
      "gamerule doMobSpawning false",
      "gamerule doDaylightCycle false",
      "gamerule doWeatherCycle false",
      "gamerule keepInventory false",
      "gamerule doFireTick false",
      "gamerule mobGriefing true",
      "weather clear 99999",
      "time set 14000",
      "kill @e[type=!minecraft:player]",
      `setworldspawn ${Math.floor(spec.startPos[0])} ${Math.floor(spec.startPos[1])} ${Math.floor(spec.startPos[2])}`,
      ...spec.terrainCommands,
    ];
    for (const cmd of baseCommands) {
      sendServerCommand(serverProc, cmd);
      await delay(25);
    }
    await delay(400);

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

    // Ensure exact position/orientation and summon hostiles cleanly once client is live & ticking!
    sendServerCommand(serverProc, `tp ${playerName} ${spec.startPos[0]} ${spec.startPos[1]} ${spec.startPos[2]} ${spec.yaw} ${spec.pitch}`);
    await delay(150);
    for (const summon of spec.summonCommands) {
      sendServerCommand(serverProc, summon);
      await delay(40);
    }

    const combatStartMs = Date.now();
    const maxWallMs = (overrideSeconds ?? spec.maxSeconds) * 1000;
    const stancesSet = new Set<string>();
    const actionsSet = new Set<string>();
    let lastMobQueryMs = 0;
    let mobsRemaining = spec.initialMobCount;
    let lastProg: ProgressSnapshot | null = firstProgress;
    let settleAfterDoneMs: number | null = null;

    while (Date.now() - combatStartMs < maxWallMs) {
      if (clientProc.exitCode !== null) break;
      const p = await readProgress(progressFile);
      if (p) {
        lastProg = p;
        metrics.alive = p.alive;
        metrics.deaths = p.deaths ?? 0;
        if (typeof p.health === "number") {
          metrics.endHp = p.health;
          metrics.minHp = Math.min(metrics.minHp, p.health);
          if (p.shelter_ever_sealed) {
            metrics.maxHpAfterShelter = Math.max(metrics.maxHpAfterShelter, p.health);
          }
        }
        if (typeof p.food === "number") metrics.endFood = p.food;
        if (typeof p.y === "number") metrics.minY = Math.min(metrics.minY, p.y);
        if (typeof p.damage_taken === "number") metrics.damageTaken = Math.max(metrics.damageTaken, p.damage_taken);
        if (p.shield_equipped) metrics.shieldEquippedEver = true;
        if (typeof p.shield_blocks === "number") metrics.shieldBlocks = Math.max(metrics.shieldBlocks, p.shield_blocks);
        if (typeof p.shield_blocking_ticks === "number") {
          metrics.shieldBlockingTicks = Math.max(metrics.shieldBlockingTicks, p.shield_blocking_ticks);
        }
        if (p.shelter_ever_sealed) metrics.shelterEverSealed = true;
        if (p.shelter_ever_roofed) metrics.shelterEverRoofed = true;
        if (typeof p.shelter_blocks_placed === "number") {
          metrics.shelterBlocksPlaced = Math.max(metrics.shelterBlocksPlaced, p.shelter_blocks_placed);
        }
        if (typeof p.mobs_killed === "number") metrics.mobsKilledObserved = Math.max(metrics.mobsKilledObserved, p.mobs_killed);
        if (p.combat_stance) stancesSet.add(p.combat_stance);
        if (p.combat_action) actionsSet.add(p.combat_action);

        // If player died, record 2s of post-death context then exit early
        if (!p.alive || (p.deaths ?? 0) > 0) {
          await delay(1500);
          break;
        }
      }

      // Periodically poll server ground-truth remaining tagged hostiles!
      const now = Date.now();
      if (now - lastMobQueryMs >= 1500) {
        lastMobQueryMs = now;
        const count = await queryTaggedMobCount(serverProc, "diag_mob");
        if (count !== null) {
          mobsRemaining = count;
          metrics.mobsRemaining = count;
          metrics.mobsKilledServer = Math.max(0, spec.initialMobCount - count);
        }
      }

      // Check early clean completion so we don't waste time after victory/shelter-heal!
      const elapsedMs = now - combatStartMs;
      let scenarioComplete = false;
      if (spec.id === "trapped_flee_shelter") {
        scenarioComplete = metrics.shelterEverSealed && metrics.shelterEverRoofed
          && (metrics.maxHpAfterShelter >= spec.startHp + 3.0 || (elapsedMs > 28_000 && metrics.maxHpAfterShelter > spec.startHp + 0.5));
      } else if (spec.id === "model_combat_decision") {
        const stratOut = strategist?.outcome();
        const applied = stratOut?.plansApplied ?? 0;
        const settledAction = metrics.shelterEverSealed || mobsRemaining === 0 || elapsedMs > 30_000;
        scenarioComplete = applied >= 1 && settledAction && elapsedMs > 18_000;
      } else {
        scenarioComplete = mobsRemaining === 0 && elapsedMs > 4_000;
      }

      if (scenarioComplete) {
        if (settleAfterDoneMs === null) settleAfterDoneMs = now + 2_500;
        else if (now >= settleAfterDoneMs) break;
      }

      await delay(250);
    }

    // Final ground-truth mob check
    const finalCount = await queryTaggedMobCount(serverProc, "diag_mob");
    if (finalCount !== null) {
      metrics.mobsRemaining = finalCount;
      metrics.mobsKilledServer = Math.max(0, spec.initialMobCount - finalCount);
    }

    // Gracefully stop client via runner-stop marker, stop strategist, stop ffmpeg, stop server
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
            if (typeof ev.combatStance === "string") metrics.modelPlanStances.push(ev.combatStance);
            if (Array.isArray(ev.tasks)) {
              for (const t of ev.tasks) {
                if (typeof t?.kind === "string") metrics.modelPlanTasks.push(t.kind);
              }
            }
          }
        }
      } catch {}
    }

    metrics.combatStancesObserved = [...stancesSet];
    metrics.combatActionsObserved = [...actionsSet];
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
  console.log(`=== Parallel Combat Diagnostic Batch ===`);
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
        "-a", "-s", `-screen 0 ${SIZE}x24 -nolisten tcp`,
        "bun", path.join(WORKTREE_ROOT, "survival-agent/diagnose-combat.ts"),
        "--single", id,
        "--run-dir", runDir,
      ];
      if (overrideSeconds !== undefined) args.push("--seconds", String(overrideSeconds));
      if (modelArg) args.push("--model", modelArg);

      const child = spawn("xvfb-run", args, {
        cwd: WORKTREE_ROOT,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8").slice(-2000); });
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
      });

      try {
        const res = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8")) as ScenarioMetrics;
        results.set(id, res);
        console.log(`[W${workerId}] ${res.passed ? "PASS" : "FAIL"} ${id} (${res.durationSec}s) — ${res.reason}`);
      } catch {
        const fallback: ScenarioMetrics = {
          scenario: id,
          passed: false,
          reason: `worker crashed (exit=${exitCode}): ${stderr.trim().slice(-300)}`,
          alive: false, deaths: 0, startHp: 0, endHp: 0, minHp: 0, maxHpAfterShelter: 0,
          startFood: 0, endFood: 0, minY: 0, damageTaken: 0, initialMobs: 0, mobsRemaining: 0,
          mobsKilledServer: 0, mobsKilledObserved: 0, shieldEquippedEver: false,
          shieldBlocks: 0, shieldBlockingTicks: 0, shelterEverSealed: false,
          shelterEverRoofed: false, shelterBlocksPlaced: 0,
          combatStancesObserved: [], combatActionsObserved: [],
          modelPlansPublished: 0, modelPlansApplied: 0, modelPlanStances: [], modelPlanTasks: [],
          durationSec: 0, videoPath: path.join(runDir, "screen.mp4"), runDir,
        };
        results.set(id, fallback);
        console.log(`[W${workerId}] FAIL ${id} — ${fallback.reason}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, scenarioIds.length) }, (_, i) => runWorker(i + 1));
  await Promise.all(workers);

  const ordered = scenarioIds.map((id) => results.get(id)!);
  const summary = {
    batchDir,
    total: ordered.length,
    passed: ordered.filter((r) => r.passed).length,
    failed: ordered.filter((r) => !r.passed).length,
    results: ordered,
  };
  await writeFile(path.join(batchDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });

  console.log("\n=== Combat Diagnostic Summary Matrix ===");
  console.log("| Scenario | Result | HP (start->end/min) | Killed | Dmg | Shield Blocks | Shelter Sealed/Roofed | Video |");
  console.log("|---|---|---|---:|---:|---|---|---|");
  for (const r of ordered) {
    const vidOk = await stat(r.videoPath).then((s) => s.size > 1024, () => false);
    console.log(
      `| ${r.scenario} | ${r.passed ? "PASS" : "FAIL"} | ${r.startHp}->${r.endHp} (min ${r.minHp}) | ${r.mobsKilledServer}/${r.initialMobs} | ${r.damageTaken} | ${r.shieldBlocks} (${r.shieldBlockingTicks}t) | ${r.shelterEverSealed}/${r.shelterEverRoofed} (${r.shelterBlocksPlaced}b) | ${vidOk ? r.videoPath : "MISSING"} |`
    );
  }
  console.log(`\nSummary JSON: ${path.join(batchDir, "summary.json")}`);
  console.log(`Result: ${summary.passed}/${summary.total} passed.`);
  process.exit(summary.failed === 0 ? 0 : 1);
}

// ===================== CLI ENTRYPOINT =====================
function parseCli(argv: string[]) {
  let single: string | undefined;
  let runDir: string | undefined;
  let scenarios = [...ALL_SCENARIO_IDS];
  let concurrency = 3;
  let batch = `batch-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  let outRoot = DEFAULT_OUT_ROOT;
  let model: string | undefined;
  let seconds: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--single") single = argv[++i];
    else if (a === "--run-dir") runDir = argv[++i];
    else if (a === "--scenarios") scenarios = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") concurrency = Math.max(1, Math.min(4, Number(argv[++i])));
    else if (a === "--batch") batch = argv[++i]!;
    else if (a === "--out-dir") outRoot = argv[++i]!;
    else if (a === "--model") model = argv[++i];
    else if (a === "--seconds") seconds = Number(argv[++i]);
    else if (a === "--list") {
      for (const s of Object.values(SCENARIOS)) console.log(`${s.id}: ${s.description}`);
      process.exit(0);
    }
  }
  return { single, runDir, scenarios, concurrency, batch, outRoot, model, seconds };
}

const cli = parseCli(process.argv.slice(2));
if (cli.single) {
  if (!cli.runDir) throw new Error("--single requires --run-dir");
  await runSingleScenario(cli.single, cli.runDir, cli.seconds, cli.model);
} else {
  const unknown = cli.scenarios.filter((id) => !(id in SCENARIOS));
  if (unknown.length > 0) throw new Error(`Unknown scenarios: ${unknown.join(", ")}`);
  await runParallelBatch(cli.scenarios, cli.concurrency, path.join(cli.outRoot, cli.batch), cli.seconds, cli.model);
}
