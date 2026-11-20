import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PENDING_FURNACE_SCOPE, preparePendingFurnace, readPendingFurnaceParent, sealPendingFurnace } from "../survival-agent/pending-furnace.ts";

const parentRun = "2026-11-20T07-00-28.012Z-diamond-Ab123Z";
const owner = "38fff701-c3bb-341d-a221-65bcbd4bb479";
const worldId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const record = "pending-furnace.json";
const close = "pending-furnace-close.json";
const temp = "pending-furnace.tmp";
const worldFiles = ["level.dat", "session.lock", `playerdata/${owner}.dat`, `stats/${owner}.json`, "region/r.-1.1.mca"];
const mtime = new Date("2025-11-01T00:00:00.000Z");
const receipt = (tick: number, frame: number) => ({ run: parentRun, life: 1, tick, frame });
const snapshot = {
  v: 1, run: parentRun, world: worldId, owner, id, originId: id, originWorld: worldId,
  dimension: "minecraft:overworld", pos: [-1, 28, 513], footing: [-2, 28, 513], facing: "north",
  raw: "minecraft:raw_iron", units: 2, fuel: "minecraft:coal", fuelCount: 1, fuelTicks: 1600,
  output: "minecraft:iron_ingot", syncId: 1, minimumOutput: 0, maximumFuel: 1,
  basis: "live", state: "parked", paid: receipt(25, 83), parked: receipt(40, 140),
};
const evidence = { owner, life: 1, progressTick: 115 };
const write = (dir: string, name: string, text: string) =>
  writeFile(path.join(dir, name), text, { mode: 0o600 });
const readJson = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, name), "utf8"));

async function fixture<T>(fn: (f: {
  source: Parameters<typeof readPendingFurnaceParent>[0];
  child: (suffix: string, alteredFile?: string) => Promise<{
    run: string; dir: string; save: { world: string; device: number };
  }>;
  rewrite: (row: Record<string, unknown>, breadcrumbs?: unknown) => Promise<void>;
  dir: string;
}) => Promise<T>) {
  const base = await mkdtemp(path.join(tmpdir(), "pending-furnace-"));
  const dir = path.join(base, parentRun);
  const world = path.join(dir, "world");
  const device = (await lstat(base)).dev;
  try {
    await mkdir(world, { recursive: true, mode: 0o700 });
    for (const name of worldFiles) {
      await mkdir(path.dirname(path.join(world, name)), { recursive: true });
      await write(world, name, "opaque vanilla file");
      await utimes(path.join(world, name), mtime, mtime);
    }
    const read = async (name: string) => readFile(path.join(dir, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    const rewrite = async (row: Record<string, unknown>, breadcrumbs?: unknown) => {
      const text = JSON.stringify(row);
      await write(dir, record, text);
      await write(dir, close, JSON.stringify({ v: 1, stamp: receipt(117, 340), id,
        record: createHash("sha256").update(text).digest("hex"), breadcrumbs }));
    };
    await write(dir, PENDING_FURNACE_SCOPE, JSON.stringify({ v: 1, run: parentRun, world: worldId }));
    await rewrite(snapshot);
    const source = { run: parentRun, world, device, read };
    const child = async (suffix: string, alteredFile?: string) => {
      const run = `2026-12-21T03-19-18.100Z-diamond-${suffix}`;
      const root = path.join(base, run);
      const destination = path.join(root, "world");
      for (const name of worldFiles) {
        const target = path.join(destination, name);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(world, name), target);
        const timestamp = name === alteredFile ? new Date(mtime.getTime() + 15_000) : mtime;
        await utimes(target, timestamp, timestamp);
      }
      return { run, dir: root, save: { world: destination, device } };
    };
    return await fn({ source: { ...source, seal: await sealPendingFurnace(source, evidence) }, child, rewrite, dir });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("a clean parent gives independent copies new observation IDs without losing original paid stamps", () =>
  fixture(async ({ source, child, dir }) => {
    expect(source.seal).toBeDefined();
    const parent = await readPendingFurnaceParent(source);
    const copies = await Promise.all([child("BrnchA"), child("BrnchB")]);
    const [a, b] = await Promise.all(copies.map(async copy => {
      await preparePendingFurnace(copy.dir, copy.run, copy.save, source, parent);
      return readJson(copy.dir, record);
    }));
    for (const [run, fork] of [[copies[0]!.run, a], [copies[1]!.run, b]]) {
      expect(fork).toMatchObject({ run, originId: id, originWorld: worldId, paid: snapshot.paid,
        parked: snapshot.parked, state: "parked", basis: "resume" });
      expect(fork.id).not.toBe(id);
      expect(fork.world).not.toBe(worldId);
    }
    expect(a.id).not.toBe(b.id);
    expect(a.world).not.toBe(b.world);
    expect(await readJson(dir, record)).toEqual(snapshot);
  }));

test("a copied save mismatch or torn record leaves only a historical clue", () =>
  fixture(async ({ source, child, dir }) => {
    const parent = await readPendingFurnaceParent(source);
    const wrongWorld = await child("Changed", "region/r.-1.1.mca");
    await preparePendingFurnace(wrongWorld.dir, wrongWorld.run, wrongWorld.save, source, parent);
    expect(await readJson(wrongWorld.dir, record)).toMatchObject({ basis: "clue", originId: id });
    await write(dir, temp, "{");
    expect(await sealPendingFurnace(source, evidence)).toBeUndefined();
    const torn = await readPendingFurnaceParent(source);
    const other = await child("Torn01");
    await preparePendingFurnace(other.dir, other.run, other.save, source, torn);
    expect(await readJson(other.dir, record)).toMatchObject({ basis: "clue", originId: id });
  }));

test("a superseding collection defeats a stale in-flight copy with no revived ticket", () =>
  fixture(async ({ source, child, rewrite }) => {
    const captured = await readPendingFurnaceParent(source);
    await rewrite({ ...snapshot, state: "collected", ended: receipt(110, 310) });
    const branch = await child("Child1");
    await preparePendingFurnace(branch.dir, branch.run, branch.save, source, captured);
    expect(await readJson(branch.dir, PENDING_FURNACE_SCOPE)).not.toHaveProperty("resume");
    expect(await readPendingFurnaceParent(source)).toBeUndefined();
  }));

test("the runner rejects malformed paid stamps and never seals a different player or life", () =>
  fixture(async ({ source, rewrite }) => {
    expect(await sealPendingFurnace(source, { ...evidence, life: 2 })).toBeUndefined();
    expect(await sealPendingFurnace(source, { ...evidence, owner: id })).toBeUndefined();
    await rewrite({ ...snapshot, paid: receipt(70, 130) });
    expect(await readPendingFurnaceParent(source)).toBeUndefined();
    await rewrite({ ...snapshot, fuelCount: 2 });
    expect(await sealPendingFurnace(source, evidence)).toBeUndefined();
  }));

const route = {
  footing: [-2, 28, 513],
  edges: [[-3, 27, 514, -3, 27, 513], [-3, 27, 513, -2, 28, 513]],
} satisfies NonNullable<Awaited<ReturnType<typeof readPendingFurnaceParent>>>["breadcrumbs"];
const floors = [{ item: "minecraft:cobblestone", count: 3 }, { item: "minecraft:iron_pickaxe", count: 1 }];

test("a sealed same-lineage continuation carries private walked clues and restriction-only floors", () =>
  fixture(async ({ source, child, rewrite }) => {
    await rewrite({ ...snapshot, floors }, route);
    const withRoute = { ...source, seal: await sealPendingFurnace(source, evidence) };
    const parent = await readPendingFurnaceParent(withRoute);
    expect(parent?.breadcrumbs).toEqual(route);
    const restored = await child("Walked");
    await preparePendingFurnace(restored.dir, restored.run, restored.save, withRoute, parent);
    expect(await readJson(restored.dir, record)).toMatchObject({
      basis: "resume", originId: id, breadcrumbs: route, floors, paid: snapshot.paid,
    });

    const changed = await child("NoWalk", "region/r.-1.1.mca");
    await preparePendingFurnace(changed.dir, changed.run, changed.save, withRoute, parent);
    const clue = await readJson(changed.dir, record);
    expect(clue).toMatchObject({ basis: "clue", originId: id });
    expect(clue).not.toHaveProperty("breadcrumbs");
    expect(clue).not.toHaveProperty("floors");
  }));

test("editing close breadcrumbs cannot mint a route or erase the paid obligation", () =>
  fixture(async ({ source, child, rewrite }) => {
    await rewrite({ ...snapshot, floors }, route);
    const sealed = { ...source, seal: await sealPendingFurnace(source, evidence) };
    const before = await readPendingFurnaceParent(sealed);
    await rewrite({ ...snapshot, floors }, { ...route, edges: [[-4, 27, 513, -2, 28, 513]] });
    const copy = await child("RouteX");
    await preparePendingFurnace(copy.dir, copy.run, copy.save, sealed, before);
    const restored = await readJson(copy.dir, record);
    expect(restored).toMatchObject({ basis: "resume", originId: id, floors });
    expect(restored).not.toHaveProperty("breadcrumbs");
  }));

test("malformed or duplicate reserve floors cannot be imported", () =>
  fixture(async ({ source, rewrite }) => {
    await rewrite({ ...snapshot, floors: [floors[0], floors[0]] });
    expect(await sealPendingFurnace(source, evidence)).toBeUndefined();
    await rewrite({ ...snapshot, floors: [{ item: "minecraft:air", count: 1 }] });
    expect(await readPendingFurnaceParent(source)).toBeUndefined();
  }));
