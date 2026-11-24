import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { SurvivalAgentGoal } from "../src/shared/survival-agent-ui.ts";

export const descentVariants = ["water", "boat", "cave"] as const;
export type DescentVariant = (typeof descentVariants)[number];
export const terrainVariants = ["birch", "ceiling", "wade-model", "brake-model"] as const;
export type TerrainVariant = (typeof terrainVariants)[number];
type FixtureVariant = DescentVariant | TerrainVariant;
type Cell = readonly [number, number, number];
type Grant = readonly [id: string, count: number];
type Command = readonly [input: string, acknowledgement: RegExp];
type Fixture = {
  goal: SurvivalAgentGoal;
  start: Cell;
  pitch: number;
  kit: readonly Grant[];
  terrain: object;
};

const DAY_TICK = 1000;
const WATER_FLOOR = 64;
const WATER_STANCE = 73;
const CAVE_STANCE = 44;
const BOAT_FLOOR = 39;
const MINE_KIT = [["iron_pickaxe", 1], ["torch", 32]] as const;
export const descentFixtures = {
  water: {
    goal: "wooden_pickaxe",
    start: [0.5, WATER_STANCE, 0.5],
    pitch: 80,
    kit: [["water_bucket", 1]],
    terrain: {
      dryLanding: { y: WATER_FLOOR, x: [-4, 4], z: [-4, 4] },
      supportedStart: "Stone support withdrawn by a vanilla pressure plate and delayed sticky piston",
      repeaters: 16,
    },
  },
  boat: {
    goal: "diamond",
    start: [0.5, CAVE_STANCE, 0.5],
    pitch: 8,
    kit: [...MINE_KIT, ["oak_boat", 1]],
    terrain: {
      dryTakeoff: { y: CAVE_STANCE, x: [-1, 1], z: [-4, 0] },
      dryLanding: { y: BOAT_FLOOR, x: [-5, 5], z: [1, 8] },
      prePlacedHull: false,
    },
  },
  cave: {
    goal: "diamond",
    start: [0.5, CAVE_STANCE, 0.5],
    pitch: 8,
    kit: MINE_KIT,
    terrain: {
      connectedShelves: [{ y: 43, z: [1, 3] }, { y: 42, z: [4, 6] }, { y: 41, z: [7, 9] }],
      sideAlcove: "West wall",
    },
  },
} as const satisfies Record<DescentVariant, Fixture>;

export const terrainFixtures = {
  birch: {
    goal: "wooden_pickaxe",
    start: [0.5, 64, 0.5],
    pitch: -59,
    kit: [],
    terrain: { upperStem: [0, 71, 3], alternateStem: [0, 64, 9] },
  },
  ceiling: {
    goal: "wooden_pickaxe",
    start: [0.5, 64, -1.5],
    pitch: 6,
    kit: [],
    terrain: { obstruction: [0, 66, 0], step: [0, 64, 1], exit: [0, 65, 3], stem: [0, 65, 8] },
  },
  "wade-model": {
    goal: "diamond",
    start: [0.5, 64, 0.60],
    pitch: 21,
    kit: [["iron_pickaxe", 1]],
    terrain: {
      inletX: 4, channelZ: 1, bedY: 63, centralWaterLevel: 4,
      ore: [0, 64, 6],
      route: "Level stone bed between two dry banks; no dry route through the side walls.",
    },
  },
  "brake-model": {
    goal: "diamond",
    start: [0.5, 64, 0.60],
    pitch: 25,
    kit: [["iron_pickaxe", 1]],
    terrain: {
      gap: { x: [-12, 12], z: [4, 9], bottomY: 52 },
      ore: [0, 64, 10],
    },
  },
} as const satisfies Record<TerrainVariant, Fixture>;

const fixtures = { ...descentFixtures, ...terrainFixtures };

export function fixtureWorld(variant: FixtureVariant) {
  const fixture = fixtures[variant];
  return {
    type: `diagnostic_${variant in terrainFixtures ? "terrain" : "descent"}_${variant}`, mode: "survival", difficulty: "normal",
    fresh: true, seed: "random", mobSpawning: false, continuable: false, generator: "minecraft:flat",
    dayTickSetBeforeJoin: DAY_TICK, terrain: fixture.terrain,
    spawn: { position: fixture.start, facing: "south", yaw: 0, pitch: fixture.pitch },
    oneTimeGrant: {
      method: "vanilla-playerdata-before-first-join",
      hotbar: fixture.kit.map(([id, count]) => ({ item: `minecraft:${id}`, count })),
    },
  };
}

const set = (cell: Cell, block: string): Command =>
  [`setblock ${cell.join(" ")} minecraft:${block}`, /^Changed the block at /];
const fill = (from: Cell, to: Cell, block: string): Command =>
  [`fill ${from.join(" ")} ${to.join(" ")} minecraft:${block}`, /^Successfully filled [1-9]\d* block\(s\)$/];
const inspect = (cell: Cell, block: string): Command =>
  [`execute if block ${cell.join(" ")} minecraft:${block}`, /^Test passed$/];

// Vanilla encodes the direction toward the input, opposite the arrow's output.
const repeater = (x: number, z: number, input: "west" | "north" | "east" | "south") =>
  set([x, WATER_STANCE - 1, z], `repeater[delay=4,facing=${input}]`);
const span = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + Math.sign(to - from) * i);

async function waterTerrain(console: (steps: Command[], allowMismatch?: boolean) => Promise<string[]>,
    signal: AbortSignal) {
  const y = WATER_STANCE - 1;
  await console([
    fill([-4, WATER_FLOOR - 1, -4], [4, WATER_FLOOR - 1, 4], "stone"),
    // Open at the top for daylight; the stone ring leaves just the player's own column.
    fill([-1, y + 1, -1], [1, y + 3, -1], "stone"),
    fill([-1, y + 1, 1], [1, y + 3, 1], "stone"),
    fill([-1, y + 1, 0], [-1, y + 3, 0], "stone"),
    fill([1, y + 1, 0], [1, y + 3, 0], "stone"),
    // The dust path stays off the center column at every height.
    fill([1, y - 1, 0], [5, y - 1, 0], "stone"),
    fill([5, y - 1, 1], [5, y - 1, 4], "stone"),
    fill([-3, y - 1, 4], [4, y - 1, 4], "stone"),
    fill([-3, y - 1, 1], [-3, y - 1, 3], "stone"),
    set([-3, y, 1], "stone"),
    ...span(1, 4).map(x => repeater(x, 0, "west")),
    set([5, y, 0], "redstone_wire"),
    ...span(1, 3).map(z => repeater(5, z, "north")),
    set([5, y, 4], "redstone_wire"),
    ...span(4, -2).map(x => repeater(x, 4, "east")),
    set([-3, y, 4], "redstone_wire"),
    ...span(3, 2).map(z => repeater(-3, z, "south")),
    set([-1, y, 0], "stone"),
    set([-2, y, 0], "sticky_piston[facing=east]"),
    set([-3, y, 0], "redstone_wall_torch[facing=north]"),
  ]);
  // Let vanilla process the piston block event before attaching the trigger to its moved support.
  const support = [0, y, 0] as const;
  const base = [-2, y, 0] as const;
  for (let tries = 0; ; tries++) {
    const mismatches = await console([
      inspect(support, "stone"), inspect(base, "sticky_piston[extended=true,facing=east]"),
    ], true);
    if (!mismatches.length) break;
    if (tries === 19) throw new Error("The vanilla piston did not establish the dry launch floor.");
    await delay(100, undefined, { signal });
  }
  return [
    set([0, WATER_STANCE, 0], "stone_pressure_plate"),
    inspect([0, WATER_STANCE, 0], "stone_pressure_plate[powered=false]"),
    inspect([0, WATER_FLOOR - 1, 0], "stone"),
    inspect([0, WATER_FLOOR, 0], "air"),
  ];
}

function chamber(variant: "boat" | "cave"): Command[] {
  const y = CAVE_STANCE;
  if (variant === "boat") return [
    // Three full blocks across the deck, with free hull clearance behind the initial lip.
    fill([-1, y, -4], [1, y + 4, 0], "air"),
    fill([-5, BOAT_FLOOR, 1], [5, y + 5, 8], "air"),
    fill([-2, y + 6, 3], [2, y + 7, 6], "air"),
    fill([-3, BOAT_FLOOR + 2, 9], [2, y + 3, 11], "air"),
    set([-1, y + 5, 0], "sea_lantern"),
    set([1, y + 5, 0], "sea_lantern"),
    set([0, y + 5, 2], "sea_lantern"),
    set([0, y + 6, 5], "sea_lantern"),
    set([0, BOAT_FLOOR + 1, 9], "sea_lantern"),
    inspect([0, y - 1, 0], "stone"),
    inspect([0, BOAT_FLOOR - 1, 2], "stone"),
    inspect([0, BOAT_FLOOR, 2], "air"),
  ];
  return [
    // The narrow approach opens into irregular dry stone shelves, not an alternate route driver.
    fill([0, y, -2], [0, y + 1, 0], "air"),
    fill([-1, y - 1, 1], [1, y + 2, 1], "air"),
    fill([-2, y - 1, 2], [2, y + 3, 3], "air"),
    fill([-3, y - 2, 4], [2, y + 4, 6], "air"),
    fill([-4, y - 1, 5], [-4, y + 2, 7], "air"),
    fill([-2, y - 3, 7], [3, y + 2, 9], "air"),
    fill([-2, y - 4, 10], [3, y + 2, 10], "air"),
    fill([-1, y - 3, 11], [1, y + 1, 12], "air"),
    set([0, y + 2, 0], "sea_lantern"),
    set([0, y + 3, 1], "sea_lantern"),
    set([0, y + 4, 3], "sea_lantern"),
    set([-2, y + 5, 5], "sea_lantern"),
    set([3, y - 1, 7], "sea_lantern"),
    inspect([0, y - 2, 1], "stone"),
    inspect([0, y - 3, 4], "stone"),
    inspect([0, y - 4, 7], "stone"),
  ];
}

function birch([x, y, z]: Cell, height: number): Command[] {
  const crown = y + height - 1;
  return [
    fill([x, y, z], [x, crown, z], "birch_log"),
    fill([x - 1, crown, z + 1], [x + 1, crown, z + 1], "birch_leaves"),
    fill([x - 1, crown + 1, z - 1], [x + 1, crown + 1, z + 1], "birch_leaves"),
    inspect([x, y, z], "birch_log"),
  ];
}

async function wadeTerrain(console: (steps: Command[], allowMismatch?: boolean) => Promise<string[]>,
    signal: AbortSignal): Promise<Command[]> {
  const { inletX, channelZ: z, bedY, centralWaterLevel, ore } = terrainFixtures["wade-model"].terrain;
  const y = bedY + 1;
  const wallSign = "oak_wall_sign[facing=east,waterlogged=false]";
  await console([
    fill([-inletX - 1, bedY, -4], [inletX + 1, bedY, 8], "stone"),
    ...[-1, 1].map(x => fill([x, y, -4], [x, y + 2, 8], "stone")),
    ...[-4, 8].map(bank => fill([0, y, bank], [0, y + 2, bank], "stone")),
    ...[z - 1, z + 1].flatMap(bank => [
      fill([-inletX, y, bank], [-1, y, bank], "stone"),
      fill([1, y, bank], [inletX, y, bank], "stone"),
      set([0, y, bank], wallSign),
    ]),
    ...[-inletX - 1, inletX + 1].map(x => set([x, y, z], "stone")),
    fill([-1, y, z], [1, y, z], "air replace minecraft:stone"),
    set(ore, "diamond_ore"),
    ...[-inletX, inletX].map(x => set([x, y, z], "water[level=0]")),
  ]);
  // The center is four horizontal spreads from each inlet on one solid bed.
  // Equal neighboring levels cancel the lateral flow; the non-waterlogged wall
  // signs stop the thin flow at each dry bank without blocking the corridor.
  const settled = [
    ...span(-inletX, inletX).map(x => inspect([x, y, z], `water[level=${centralWaterLevel - Math.abs(x)}]`)),
    inspect([0, bedY, z], "stone"),
    inspect([0, y + 1, z], "air"),
    ...[z - 1, z + 1].flatMap(bank => [inspect([0, bedY, bank], "stone"), inspect([0, y, bank], wallSign)]),
    inspect(ore, "diamond_ore"),
  ];
  for (let retry = 0; retry < 12; ++retry) {
    await delay(250, undefined, { signal });
    if (!(await console(settled, true)).length) return [];
  }
  throw new Error("Vanilla did not settle the shallow-water channel and both dry banks before join.");
}

function terrain(variant: Exclude<TerrainVariant, "wade-model">): Command[] {
  if (variant === "brake-model") {
    const { start: [, y], terrain: { gap: { x: [left, right], z: [lip, last], bottomY }, ore } } =
      terrainFixtures[variant];
    return [
      fill([left, y - 1, -4], [right, y - 1, 13], "stone"),
      fill([left, bottomY, lip], [right, y - 1, last], "air"),
      set(ore, "diamond_ore"),
      inspect([0, y - 1, lip - 1], "stone"),
      inspect([0, y - 1, lip], "air"),
      inspect([0, bottomY, lip], "air"),
      inspect([0, bottomY - 1, lip], "stone"),
      inspect([0, y - 1, last], "air"),
      inspect([0, y - 1, last + 1], "stone"),
      inspect(ore, "diamond_ore"),
    ];
  }
  if (variant === "birch") {
    const { upperStem: high, alternateStem: alternate } = terrainFixtures.birch.terrain;
    return [
      // The exposed upper section of a birch after the lower trunk has been cut.
      ...birch(high, 3),
      ...birch(alternate, 5),
      inspect([high[0], high[1] - 1, high[2]], "air"),
      inspect([high[0], 63, high[2]], "grass_block"),
    ];
  }
  const { obstruction, step, stem } = terrainFixtures.ceiling.terrain;
  return [
    // A stone notch with a single dirt overhang on the lower side of its one-block rise.
    fill([-1, 64, -6], [-1, 67, 4], "stone"),
    fill([1, 64, -6], [1, 67, 4], "stone"),
    fill(step, [0, 64, 10], "stone"),
    set(obstruction, "dirt"),
    ...birch(stem, 5),
    inspect(obstruction, "dirt"),
    inspect([0, 65, 0], "air"),
    inspect(step, "stone"),
    inspect([0, 67, 1], "air"),
  ];
}

function preJoinConsole(server: ChildProcess, signal: AbortSignal) {
  const { stdin, stdout } = server;
  if (!stdin || !stdout) throw new Error("Diagnostic setup requires the owned vanilla console.");
  return async (steps: Command[], allowMismatch = false) => {
    const ack = Promise.withResolvers<string[]>();
    signal.throwIfAborted();
    let partial = "";
    const replies: string[] = [];
    const onOutput = (chunk: Buffer) => {
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        const message = line.match(/^\[[^\]]+\] \[Server thread\/INFO\]: (.*)$/)?.[1]?.trim();
        if (!message) continue;
        if (/^The time is \d+$/.test(message)) {
          const failed = steps.filter(([, expected], i) => !expected.test(replies[i] ?? ""));
          ack.resolve(replies.length === steps.length && !failed.length ? [] :
            failed.length ? failed.map(([command]) => command) : ["unexpected vanilla console output"]);
          return;
        }
        replies.push(message);
      }
    };
    const abort = () => ack.reject(signal.reason);
    stdout.on("data", onOutput);
    signal.addEventListener("abort", abort, { once: true });
    try {
      stdin.write(`${steps.map(([command]) => command).join("\n")}\ntime query gametime\n`,
        error => { if (error) ack.reject(error); });
      const failed = await ack.promise;
      if (failed.length && !allowMismatch) throw new Error(`Vanilla did not confirm diagnostic setup: ${failed[0]}.`);
      return failed;
    } finally {
      stdout.off("data", onOutput);
      signal.removeEventListener("abort", abort);
    }
  };
}

// The pinned Java Edition 1.21.4 gzip player save is written once, before joining.
const end = Buffer.from([0]);
function number(size: 2 | 4 | 8, value: number, kind: "int" | "float" = "int") {
  const bytes = Buffer.alloc(size);
  if (size === 2) bytes.writeInt16BE(value);
  else if (size === 8) bytes.writeDoubleBE(value);
  else if (kind === "float") bytes.writeFloatBE(value);
  else bytes.writeInt32BE(value);
  return bytes;
}
const text = (value: string) => Buffer.concat([number(2, value.length), Buffer.from(value, "ascii")]);
const tag = (id: number, name: string, ...data: Buffer[]) => Buffer.concat([Buffer.from([id]), text(name), ...data]);
const list = (name: string, id: number, data: Buffer[]) => tag(9, name, Buffer.from([id]), number(4, data.length), ...data);

function playerData({ start, pitch, kit }: Fixture) {
  return gzipSync(tag(10, "",
    tag(3, "DataVersion", number(4, 4189)),
    tag(8, "Dimension", text("minecraft:overworld")),
    tag(3, "playerGameType", number(4, 0)),
    list("Pos", 6, start.map(value => number(8, value))),
    list("Motion", 6, [0, 0, 0].map(value => number(8, value))),
    list("Rotation", 5, [0, pitch].map(value => number(4, value, "float"))),
    tag(1, "OnGround", Buffer.from([1])),
    tag(2, "Air", number(2, 300)),
    tag(5, "Health", number(4, 20, "float")),
    tag(3, "foodLevel", number(4, 20)),
    tag(5, "foodSaturationLevel", number(4, 5, "float")),
    tag(3, "SelectedItemSlot", number(4, 0)),
    list("Inventory", 10, kit.map(([item, count], slot) => Buffer.concat([
      tag(1, "Slot", Buffer.from([slot])),
      tag(8, "id", text(`minecraft:${item}`)),
      tag(3, "count", number(4, count)),
      end,
    ]))),
    end,
  ));
}

function offlineUuid(profile: string) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(profile)) throw new Error("Invalid diagnostic profile name.");
  const bytes = createHash("md5").update(`OfflinePlayer:${profile}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const macroTrialFixture = {
  goal: "wooden_pickaxe", start: [0.5, 64, 0.5], pitch: 30, kit: [],
  terrain: { stonePlatform: { from: [-4, 63, -4], to: [4, 63, 4] }, witness: [0, 64, 5] },
} as const satisfies Fixture;

export const macroTrialWorld = {
  type: "prepared-flat-reader-walk-v1",
  mode: "survival",
  difficulty: "normal",
  fresh: true,
  grants: false,
  seed: "random",
  spawn: { position: macroTrialFixture.start, yaw: 0, pitch: macroTrialFixture.pitch },
  terrain: macroTrialFixture.terrain,
} as const;

async function writePreparedPlayer(serverDir: string, profile: string, fixture: Fixture, signal: AbortSignal) {
  const players = path.join(serverDir, "world", "playerdata");
  await mkdir(players, { recursive: true, mode: 0o700 });
  await writeFile(path.join(players, `${offlineUuid(profile)}.dat`), playerData(fixture),
    { flag: "wx", mode: 0o600, signal });
}

export async function provisionMacroTrialWorld(server: ChildProcess, serverDir: string,
    profile: string, signal: AbortSignal) {
  const { stonePlatform: { from, to }, witness } = macroTrialFixture.terrain;
  await preJoinConsole(server, signal)([
    ["setworldspawn 0 64 0 0", /^Set the world spawn point to 0, 64, 0 \[0(?:\.0+)?\]$/],
    ["gamerule doMobSpawning false", /^Gamerule doMobSpawning is now set to: false$/],
    ["gamerule doDaylightCycle false", /^Gamerule doDaylightCycle is now set to: false$/],
    fill(from, to, "stone"), set(witness, "oak_log"),
    inspect([0, 63, 1], "stone"), inspect([0, 64, 1], "air"),
    [`time set ${DAY_TICK}`, new RegExp(`^Set the time to ${DAY_TICK}$`)],
  ]);
  await writePreparedPlayer(serverDir, profile, macroTrialFixture, signal);
}

const urgentFixture = {
  goal: "diamond", start: [0.5, 64, 0.5], pitch: 12,
  kit: [["oak_planks", 5], ["stick", 2]],
  terrain: { workbench: [2, 64, 2], oakLog: [0, 64, 5] },
} as const satisfies Fixture;

export const urgentThreatWorld = {
  type: "prepared-vanilla-creeper-interrupt-v1",
  mode: "survival", difficulty: "normal", fresh: true,
  spawn: { position: urgentFixture.start, yaw: 0, pitch: urgentFixture.pitch },
  terrain: { generator: "minecraft:flat", ...urgentFixture.terrain },
  oneTimeGrant: urgentFixture.kit,
} as const;

export async function provisionUrgentThreatWorld(server: ChildProcess, serverDir: string,
    profile: string, signal: AbortSignal) {
  await preJoinConsole(server, signal)([
    ["setworldspawn 0 64 0 0", /^Set the world spawn point to 0, 64, 0 \[0(?:\.0+)?\]$/],
    ["gamerule doMobSpawning false", /^Gamerule doMobSpawning is now set to: false$/],
    ["gamerule doDaylightCycle false", /^Gamerule doDaylightCycle is now set to: false$/],
    fill([-12, 63, -12], [12, 63, 12], "stone"),
    set(urgentFixture.terrain.workbench, "crafting_table"),
    set(urgentFixture.terrain.oakLog, "oak_log"),
    [`time set ${DAY_TICK}`, new RegExp(`^Set the time to ${DAY_TICK}$`)],
  ]);
  await writePreparedPlayer(serverDir, profile, urgentFixture, signal);
}

const urgentCraftFixture = {
  goal: "stone_pickaxe", start: [0.5, 64, 0.5], pitch: 20,
  kit: [["cobblestone", 4], ["stick", 2]],
  terrain: { workbench: [0, 64, 4] },
} as const satisfies Fixture;

export const urgentCraftWorld = {
  type: "prepared-vanilla-creeper-crafting-v1",
  mode: "survival", difficulty: "normal", fresh: true,
  spawn: { position: urgentCraftFixture.start, yaw: 0, pitch: urgentCraftFixture.pitch },
  terrain: { generator: "minecraft:flat", ...urgentCraftFixture.terrain },
  oneTimeGrant: urgentCraftFixture.kit,
} as const;

export async function provisionUrgentCraftWorld(server: ChildProcess, serverDir: string,
    profile: string, signal: AbortSignal) {
  await preJoinConsole(server, signal)([
    ["setworldspawn 0 64 0 0", /^Set the world spawn point to 0, 64, 0 \[0(?:\.0+)?\]$/],
    ["gamerule doMobSpawning false", /^Gamerule doMobSpawning is now set to: false$/],
    ["gamerule doDaylightCycle false", /^Gamerule doDaylightCycle is now set to: false$/],
    fill([-12, 63, -12], [12, 63, 12], "stone"),
    set(urgentCraftFixture.terrain.workbench, "crafting_table"),
    [`time set ${DAY_TICK}`, new RegExp(`^Set the time to ${DAY_TICK}$`)],
  ]);
  await writePreparedPlayer(serverDir, profile, urgentCraftFixture, signal);
}

export async function provisionFixture(variant: FixtureVariant, server: ChildProcess, serverDir: string,
    profile: string, signal: AbortSignal) {
  const console = preJoinConsole(server, signal);
  await console([
    ["setworldspawn 0 64 0 0", /^Set the world spawn point to 0, 64, 0 \[0(?:\.0+)?\]$/],
    ["gamerule doMobSpawning false", /^Gamerule doMobSpawning is now set to: false$/],
  ]);
  const steps = variant === "water" ? await waterTerrain(console, signal) :
    variant === "boat" || variant === "cave" ? chamber(variant) :
      variant === "wade-model" ? await wadeTerrain(console, signal) : terrain(variant);
  await console([...steps, [`time set ${DAY_TICK}`, new RegExp(`^Set the time to ${DAY_TICK}$`)]]);
  await writePreparedPlayer(serverDir, profile, fixtures[variant], signal);
}
