import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MinecraftServer } from "../src/server/minecraft-server.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "gameharness-world-seed-"));
  directories.push(value);
  return value;
}
/** Exercise the real deterministic property writer only, never provisioning a server/client. */
async function configuration(root: string, worldSeed?: string) {
  const write = Reflect.get(MinecraftServer.prototype, "configuration");
  if (typeof write !== "function") throw new Error("The server configuration writer is unavailable");
  await write.call({ worldSeed, directory: () => root });
}

test("trusted seed rejects newlines, property injection and escaped values before any I/O", () => {
  for (const worldSeed of ["", "2026\ndifficulty=peaceful", "2026\rlevel-type=flat", "seed\\n", "level-seed=1", " seed", "seed ", "s".repeat(129)])
    expect(() => new MinecraftServer(() => {}, () => {}, { worldSeed })).toThrow();
  expect(() => new MinecraftServer(() => {}, () => {}, { worldSeed: "20261022" })).not.toThrow();
  expect(() => new MinecraftServer(() => {}, () => {})).not.toThrow();
});

test("a declared seed configures a new normal Survival world while omitted seed preserves the default", async () => {
  const root = await directory();
  await configuration(root);
  const defaults = await readFile(path.join(root, "server.properties"), "utf8");
  expect(defaults).not.toContain("level-seed=");
  await configuration(root, "20261022");
  const seeded = await readFile(path.join(root, "server.properties"), "utf8");
  expect(seeded).toContain("level-seed=20261022\n");
  expect(seeded).toContain("gamemode=survival\n");
  expect(seeded).toContain("difficulty=normal\n");
  expect(seeded).toContain("level-type=minecraft\\:normal\n");
});

test("existing worlds never silently adopt a new or previously undeclared seed", async () => {
  const root = await directory();
  await mkdir(path.join(root, "world"));
  await writeFile(path.join(root, "world/level.dat"), "Existing-world marker; not launched");
  const original = "gamemode=survival\nlevel-seed=123\n";
  await writeFile(path.join(root, "server.properties"), original);
  await expect(configuration(root, "20261022")).rejects.toThrow("silently reseeded");
  expect(await readFile(path.join(root, "server.properties"), "utf8")).toBe(original);
  await configuration(root, "123");
  expect(await readFile(path.join(root, "server.properties"), "utf8")).toContain("level-seed=123\n");
  await writeFile(path.join(root, "server.properties"), "gamemode=survival\n");
  await expect(configuration(root, "20261022")).rejects.toThrow("silently reseeded");
});
