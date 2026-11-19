import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const SPAWN_BLOCK = [0, 64, 0] as const;
const SPAWN_POSITION = [SPAWN_BLOCK[0] + 0.5, SPAWN_BLOCK[1], SPAWN_BLOCK[2] + 0.5] as const;
const YAW = 0;
const PITCH = 33;
const DAY_TICK = 1000;
const LAVA_FROM = [-3, 63, 2] as const;
const LAVA_TO = [3, 63, 7] as const;
const BANK_FROM = [-5, 62, -6] as const;
const BANK_TO = [5, 63, 8] as const;
type Cell = readonly [number, number, number];
const volume = (from: Cell, to: Cell) => (to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1);
const LAYERS = [
  { height: 1, block: "minecraft:bedrock" },
  { height: 124, block: "minecraft:stone" },
  { height: 2, block: "minecraft:dirt" },
  { height: 1, block: "minecraft:grass_block" },
];
const KIT = [
  { item: "minecraft:stone_pickaxe", count: 1 },
  { item: "minecraft:water_bucket", count: 1 },
  { item: "minecraft:flint_and_steel", count: 1 },
  { item: "minecraft:cobblestone", count: 64 },
  { item: "minecraft:cooked_beef", count: 8 },
];

export const poolDiagnosticWorld = {
  type: "diagnostic_lava_pool",
  mode: "survival",
  difficulty: "normal",
  fresh: true,
  seed: "random",
  terrain: {
    generator: "minecraft:flat", biome: "minecraft:plains", layers: LAYERS, structures: false,
    stoneApron: { from: BANK_FROM, to: BANK_TO },
    lavaPool: { from: LAVA_FROM, to: LAVA_TO, sourceBlocks: volume(LAVA_FROM, LAVA_TO), depthBlocks: 1 },
    frameOrMoldAtStart: false,
  },
  spawn: { position: SPAWN_POSITION, facing: "south", yaw: YAW, pitch: PITCH },
  dayTickSetBeforeJoin: DAY_TICK,
  oneTimeGrant: { method: "vanilla-playerdata-before-first-join", hotbar: KIT },
} as const;

export const poolDiagnosticServerProperties = [
  "level-type=minecraft:flat",
  "generate-structures=false",
  `generator-settings=${JSON.stringify({
    biome: "minecraft:plains", layers: LAYERS, lakes: false, features: false, structure_overrides: [],
  })}`,
];

// Only these fixed world edits run, on the owned console before any client exists.
async function setUpTerrain(server: ChildProcess, signal: AbortSignal) {
  const { stdin, stdout } = server;
  if (!stdin || !stdout) throw new Error("Diagnostic setup needs the owned vanilla console.");
  const commands = [
    `fill ${BANK_FROM.join(" ")} ${BANK_TO.join(" ")} minecraft:stone`,
    `fill ${LAVA_FROM.join(" ")} ${LAVA_TO.join(" ")} minecraft:lava[level=0]`,
    `setworldspawn ${SPAWN_BLOCK.join(" ")} ${YAW}`,
    `time set ${DAY_TICK}`,
  ];
  const timeAck = `Set the time to ${DAY_TICK}`;
  const expected = [
    `Successfully filled ${volume(BANK_FROM, BANK_TO)} block(s)`,
    `Successfully filled ${volume(LAVA_FROM, LAVA_TO)} block(s)`,
    `Set the world spawn point to ${SPAWN_BLOCK.join(", ")} [${YAW}]`,
  ];
  const ready = Promise.withResolvers<void>();
  let pending = "";
  let matched = 0;
  const readOutput = (chunk: Buffer) => {
    const lines = (pending + chunk.toString("utf8")).split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      const message = line.match(/^\[[^\]]+\] \[Server thread\/INFO\]: (.*)$/)?.[1]?.trim();
      if (!message) continue;
      // The spawn command formats its yaw as a float.
      if (expected[matched] === message.replace(/\.0+]$/, "]")) ++matched;
      else if (message === timeAck) {
        if (matched === expected.length) ready.resolve();
        else ready.reject(new Error("Vanilla did not confirm all diagnostic terrain edits."));
      }
    }
  };
  const abort = () => ready.reject(signal.reason);
  signal.throwIfAborted();
  stdout.on("data", readOutput);
  signal.addEventListener("abort", abort, { once: true });
  try {
    stdin.write(`${commands.join("\n")}\n`, (error) => { if (error) ready.reject(error); });
    await ready.promise;
  } finally {
    signal.removeEventListener("abort", abort);
    stdout.off("data", readOutput);
  }
}

// Java Edition 1.21.4's gzip-compressed player NBT. The fixed tag strings are ASCII.
const END = Buffer.from([0]);
const int = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
const short = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
};
const float = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatBE(value);
  return bytes;
};
const double = (value: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes;
};
const text = (value: string) => Buffer.concat([short(value.length), Buffer.from(value, "ascii")]);
const tag = (id: number, name: string, ...value: Buffer[]) =>
  Buffer.concat([Buffer.from([id]), text(name), ...value]);
const list = (name: string, id: number, items: Buffer[]) =>
  tag(9, name, Buffer.from([id]), int(items.length), ...items);

function initialPlayerData() {
  return gzipSync(tag(10, "",
    tag(3, "DataVersion", int(4189)),
    tag(8, "Dimension", text("minecraft:overworld")),
    tag(3, "playerGameType", int(0)),
    list("Pos", 6, SPAWN_POSITION.map(double)),
    list("Motion", 6, [0, 0, 0].map(double)),
    list("Rotation", 5, [YAW, PITCH].map(float)),
    tag(1, "OnGround", Buffer.from([1])),
    tag(2, "Air", short(300)),
    tag(5, "Health", float(20)),
    tag(3, "foodLevel", int(20)),
    tag(5, "foodSaturationLevel", float(5)),
    tag(3, "SelectedItemSlot", int(0)),
    list("Inventory", 10, KIT.map(({ item, count }, slot) => Buffer.concat([
      tag(1, "Slot", Buffer.from([slot])),
      tag(8, "id", text(item)),
      tag(3, "count", int(count)),
      END,
    ]))),
    END,
  ));
}

function offlineUuid(profileName: string) {
  // The launcher has already verified the official profile. Vanilla derives the
  // save filename from its name when the owned loopback server uses local auth.
  if (!/^[A-Za-z0-9_]{1,16}$/.test(profileName)) throw new Error("Invalid diagnostic profile name.");
  const bytes = createHash("md5").update(`OfflinePlayer:${profileName}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function provisionPoolDiagnostic(server: ChildProcess, serverDir: string, profileName: string,
    signal: AbortSignal) {
  const uuid = offlineUuid(profileName);
  const players = path.join(serverDir, "world", "playerdata");
  await mkdir(players, { recursive: true, mode: 0o700 });
  await writeFile(path.join(players, `${uuid}.dat`), initialPlayerData(), { flag: "wx", mode: 0o600, signal });
  await setUpTerrain(server, signal);
}
