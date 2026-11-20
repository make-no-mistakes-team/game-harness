import { expect, spyOn, test } from "bun:test";
import { link, mkdtemp, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MacroDirectory, MacroObservationRotating, parseMacroObservation, parseMacroProposal, parseMacroWorkOrder } from "../src/server/survival-macro/protocol.ts";

test("Work program caps apply across stages and a later job cannot lower an earlier reserve", () => {
  const log = "minecraft:oak_log";
  const stage = (item: string, maxBreaks: number, reserve: number, spend: number) => ({
    policy: { target: { kind: "stock", item, count: 4 }, allowedEffects: [], maxBreaks, maxCrafts: 0, maxPlacements: 0,
      reserves: [{ item: log, count: reserve }], costCaps: [{ item: log, count: spend }] },
    requires: [],
  });
  const proposal = (...stages: ReturnType<typeof stage>[]) => ({
    action: { kind: "work-program", stages }, expiresTick: 210,
    subgoal: "Gain supplies", reason: "Prepare resources", successCondition: "Observe both stocks",
    contingency: "Stop if progress is blocked", alternative: "Review the available effects",
  });
  const first = stage(log, 40, 2, 2_000);
  const next = (breaks: number, reserve: number, cost: number) => stage("minecraft:oak_planks", breaks, reserve, cost);
  expect(parseMacroProposal(proposal(first, next(24, 2, 304))).action.kind).toBe("work-program");
  expect(() => parseMacroProposal(proposal(first, next(25, 2, 304)))).toThrow("work program effect caps");
  expect(() => parseMacroProposal(proposal(first, next(24, 2, 305)))).toThrow("work program item cost cap");
  expect(() => parseMacroProposal(proposal(first, next(24, 1, 304)))).toThrow("work program reserves regressed");
});

test("A personal crafting handoff can name only the immediate stage of the original program", () => {
  const order = {
    v: 1, id: "program:1", run: "run", life: 1, epoch: 1, basisTick: 10, expiresTick: 100, safetyRevision: 1, origin: "model",
    target: { kind: "preset", goal: "wooden_pickaxe" }, allowedEffects: [], costCaps: [], reserves: [],
    maxBreaks: 0, maxCrafts: 1, maxPlacements: 0,
  };
  expect(parseMacroWorkOrder(order).nextWorkId).toBeUndefined();
  expect(parseMacroWorkOrder({ ...order, nextWorkId: "program:2" }).nextWorkId).toBe("program:2");
  expect(() => parseMacroWorkOrder({ ...order, nextWorkId: "program:3" })).toThrow("work successor scope");
  expect(() => parseMacroWorkOrder({ ...order, nextWorkId: "different:2" })).toThrow("work successor scope");
  expect(() => parseMacroWorkOrder({ ...order, origin: "preset", nextWorkId: "program:2" })).toThrow("work successor scope");
});

test("Iron smelting and furnace placement require an exact, single live stock policy", () => {
  const smelt = "smelt:minecraft:iron_ingot", place = "place:minecraft:furnace";
  const target = { kind: "stock", item: "minecraft:iron_ingot", count: 3 };
  const rawIron = { item: "minecraft:raw_iron", count: 2 };
  const fuel = { item: "minecraft:oak_planks", count: 2 };
  const furnace = { item: "minecraft:furnace", count: 1 };
  const policy = { target, allowedEffects: [smelt, place], costCaps: [rawIron, fuel, furnace],
    reserves: [], maxBreaks: 0, maxCrafts: 2, maxPlacements: 1 };
  const order = { ...policy, v: 1, id: "work-iron", run: "run", life: 1, epoch: 1, basisTick: 10,
    expiresTick: 1000, safetyRevision: 1, origin: "model" };
  const proposal = (action: unknown) => ({ action, subgoal: "Refine iron", reason: "Raw iron is carried",
    successCondition: "Three ingots in inventory", contingency: "Stop if the furnace site is unsafe",
    alternative: "Keep the raw iron", expiresTick: 1000 });
  expect(parseMacroProposal(proposal({ kind: "work", policy })).action).toMatchObject({ kind: "work", policy: { target } });
  expect(parseMacroWorkOrder(order)).toMatchObject({
    allowedEffects: [place, smelt], costCaps: [furnace, fuel, rawIron], maxCrafts: 2, maxPlacements: 1,
  });
  expect(parseMacroWorkOrder({ ...order, allowedEffects: [smelt], costCaps: [rawIron, fuel], maxPlacements: 0 }).maxPlacements).toBe(0);
  for (const invalid of [
    { ...order, origin: "preset" }, { ...order, id: "program:3" }, { ...order, nextWorkId: "program:2" },
    { ...order, target: { kind: "preset", goal: "iron_pickaxe" } },
    { ...order, target: { kind: "stock", item: "minecraft:bucket", count: 1 } },
    { ...order, allowedEffects: [place] }, { ...order, allowedEffects: ["smelt:minecraft:gold_ingot", place] },
    { ...order, costCaps: [fuel, furnace] }, { ...order, costCaps: [rawIron, furnace] },
    { ...order, costCaps: [rawIron, { item: "minecraft:warped_planks", count: 2 }, furnace] },
    { ...order, costCaps: [rawIron, fuel] }, { ...order, maxCrafts: 0 }, { ...order, maxPlacements: 0 },
  ]) expect(() => parseMacroWorkOrder(invalid)).toThrow();
  expect(() => parseMacroProposal(proposal({ kind: "work-program", stages: [
    { policy, requires: [] },
    { policy: { target: { kind: "stock", item: "minecraft:bucket", count: 1 }, allowedEffects: ["craft:bucket"],
      costCaps: [{ item: "minecraft:iron_ingot", count: 3 }], reserves: [], maxBreaks: 0, maxCrafts: 1, maxPlacements: 0 }, requires: [] },
  ] }))).toThrow("single live work policy");

  const progress = { phase: "smelt", status: "Cooking 2 raw iron", breaks: 0, crafts: 0, placements: 1,
    target: { item: target.item, count: 1, required: target.count } };
  expect(parseMacroObservation({
    v: 1, run: "run", life: 1, epoch: 1, tick: 20, goal: "diamond", health: 20, food: 20,
    inventory: { [target.item]: 1 }, opportunities: [], recent: [], quiescent: false,
    workOrder: { id: order.id, state: "working", detail: "Waiting for furnace output", progress },
  }).workOrder).toMatchObject({
    state: "working", progress: { phase: "smelt", crafts: 0, target: { count: 1, required: 3 } },
  });
});

test.each([
  { count: 1, label: "A displaced observation is reopened from the canonical path" },
  { count: 2, label: "Repeated observation replacement defers instead of parsing a displaced snapshot" },
])("$label", async ({ count }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "macro-snapshot-"));
    const current = path.join(directory, "observation.json");
    let ipc: MacroDirectory | undefined;
    let restore: (() => void) | undefined;
    try {
      const paths = [current, ...Array.from({ length: count }, (_, i) => path.join(directory, `observation.next-${i}`))];
      await Promise.all(paths.map((file, i) => writeFile(file, `{"tick":${10 + i}}\n`, { mode: 0o600 })));
      ipc = await MacroDirectory.open(directory);
      const probe = await open(current, "r");
      const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, "stat">;
      const descriptorStat = prototype.stat;
      const first = await probe.stat();
      await probe.close();

      const second = count > 1 ? await open(paths[1]!, "r") : null;
      const next = await second?.stat();
      await second?.close();
      const predecessors = next ? [first, next] : [first];
      let rotated = 0;
      const stat = spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
        const opened = await descriptorStat.call(this);
        const expected = predecessors[rotated];
        if (opened.ino === expected?.ino && opened.dev === expected.dev) {
          await rename(paths[++rotated]!, current);
        }
        return Reflect.apply(descriptorStat, this, args);
      } as typeof descriptorStat);
      restore = () => stat.mockRestore();

      if (count === 1) {
        expect(await ipc.read("observation.json", value => value)).toEqual({ tick: 11 });
      } else {
        await expect(ipc.read("observation.json", () => { throw new Error("A displaced snapshot must not be read."); }))
          .rejects.toBeInstanceOf(MacroObservationRotating);
        expect(await ipc.read("observation.json", value => value)).toEqual({ tick: 12 });
      }
      expect(rotated).toBe(count);
    } finally {
      restore?.();
      await ipc?.close();
      await rm(directory, { recursive: true, force: true });
    }
});

test("Stable multiply linked observations and receipts are still invalid IPC files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "macro-snapshot-"));
  let ipc: MacroDirectory | undefined;
  try {
    const file = path.join(directory, "observation.json");
    await writeFile(file, '{"tick":10}\n', { mode: 0o600 });
    await link(file, path.join(directory, "receipt.json"));
    ipc = await MacroDirectory.open(directory);
    await expect(ipc.read("observation.json", value => value)).rejects.toThrow("Invalid macro IPC file: observation.json.");
    await expect(ipc.read("receipt.json", value => value)).rejects.toThrow("Invalid macro IPC file: receipt.json.");
  } finally {
    await ipc?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
