import { expect, test } from "bun:test";
import type { MacroObservation, MacroStockFloor, MacroWorkPolicy, MacroWorkStage } from "../src/server/survival-macro/protocol.ts";
import { preflightVanillaWork } from "../src/server/survival-macro/vanilla-work.ts";

const log = "minecraft:oak_log";
const oak = "minecraft:oak_planks";
const birch = "minecraft:birch_planks";
const stick = "minecraft:stick";
const table = "minecraft:crafting_table";
const tableOffer: MacroObservation["opportunities"] = [{
  id: "o-1", verb: "interact", risk: "guarded", summary: `Open visible ${table}`,
  evidence: "A lit workstation face is inside vanilla use reach.",
}];
const floor = (item: string, count: number): MacroStockFloor => ({ item, count });
const stage = (policy: Pick<MacroWorkPolicy, "target" | "allowedEffects"> & Partial<MacroWorkPolicy>,
  requires: readonly MacroStockFloor[] = []): MacroWorkStage => ({
  policy: { costCaps: [], reserves: [], maxBreaks: 0, maxCrafts: 0, maxPlacements: 0, ...policy }, requires,
});
const stock = (item: string, count: number) => ({ kind: "stock", item, count } as const);
const pick = { kind: "preset", goal: "wooden_pickaxe" } as const;
const tablePlacement = `place:${table}`;
const pickStage = (plankItem = oak) => stage({
  target: pick,
  allowedEffects: ["craft:wooden_pickaxe", "craft:stick", "craft:crafting_table", tablePlacement],
  costCaps: [floor(plankItem, 9), floor(stick, 2), floor(table, 1)], reserves: [floor(plankItem, 4)],
  maxCrafts: 3, maxPlacements: 1,
});
const check = (inventory: MacroObservation["inventory"], stages: readonly MacroWorkStage[],
  opportunities: MacroObservation["opportunities"] = []) => preflightVanillaWork({ inventory, opportunities }, stages);

test("An optional attached support neither spends a stock floor nor certifies a cave route", () => {
  const cobble = "minecraft:cobblestone";
  const policy = stage({ target: stock("minecraft:diamond", 1),
    allowedEffects: ["prospect:minecraft:diamond", "break:minecraft:diamond_ore", `place:${cobble}`],
    maxBreaks: 12, maxPlacements: 1, costCaps: [floor(cobble, 1)], reserves: [floor(cobble, 4)] });
  expect(check({ [cobble]: 4 }, [policy])).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("4 held, 4 reserved"),
  });
  expect(check({ [cobble]: 5 }, [policy])).toEqual({ kind: "unknown" });
});

test("A new bench needs thirteen planks including the reserve, but a witnessed usable bench changes the calculation", () => {
  const stages = [pickStage()];
  expect(check({ [oak]: 12 }, stages)).toMatchObject({
    kind: "unknown", stageIndex: 0,
    detail: expect.stringContaining("needs 13 minecraft:oak_planks at entry (9 to spend and 4 to retain), but only 12"),
  });
  expect(check({ [oak]: 13 }, stages)).toEqual({ kind: "possible" });
  expect(check({ [oak]: 12 }, stages, tableOffer)).toEqual({ kind: "possible" });
  // Even with a witnessed table, a stick batch and one pick require five unreserved planks.
  expect(check({ [oak]: 8 }, stages, tableOffer)).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("needs 9 minecraft:oak_planks"),
  });
});

test("Real carried equipment removes crafting spend, but a carried table is still spent when placed", () => {
  const final = {
    target: pick, allowedEffects: ["craft:wooden_pickaxe", tablePlacement],
    costCaps: [floor(birch, 3), floor(stick, 2), floor(table, 1)], maxCrafts: 1, maxPlacements: 1,
  };
  const ready = { [birch]: 3, [stick]: 2, [table]: 1 };
  expect(check(ready, [stage(final)])).toEqual({ kind: "possible" });
  const protectedTable = [stage({ ...final, reserves: [floor(table, 1)] })];
  expect(check(ready, protectedTable)).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("needs 2 minecraft:crafting_table"),
  });
  expect(check(ready, protectedTable, tableOffer)).toEqual({ kind: "possible" });
  expect(check({ "minecraft:wooden_pickaxe": 1, [table]: 1 }, protectedTable)).toEqual({ kind: "possible" });
});

test("The post-smelt bucket quote distinguishes a recent table clue from a usable or carried table", () => {
  const iron = "minecraft:iron_ingot", pickaxe = "minecraft:iron_pickaxe";
  const inventory = { [iron]: 3, [pickaxe]: 1 };
  const policy = stage({ target: stock("minecraft:bucket", 1), allowedEffects: ["craft:bucket"],
    maxCrafts: 1, costCaps: [floor(iron, 3)], reserves: [floor(pickaxe, 1)] });
  const clue: MacroObservation["opportunities"] = [{
    id: "o-2", verb: "survey", risk: "read", summary: `Reacquire recent ${table}`,
    evidence: "Turn in place toward the last witnessed face; this does not confirm access or open a screen.",
  }];
  expect(check(inventory, [policy], clue)).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("No crafting table is currently witnessed in reach."),
  });
  expect(check(inventory, [policy], clue)).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("A recent table clue permits a camera check, not access."),
  });
  expect(check(inventory, [policy], tableOffer)).toEqual({ kind: "possible" });
  expect(check({ ...inventory, [table]: 1 }, [policy], clue).kind).toBe("unknown");
  expect(check({ ...inventory, [iron]: 2 }, [policy], clue).kind).toBe("shortage");
});

test("Filling needs a witnessed source and exactly one empty bucket above the declared floors", () => {
  const bucket = "minecraft:bucket", pickaxe = "minecraft:iron_pickaxe", filled = "minecraft:water_bucket";
  const fill = stage({ target: stock(filled, 1), allowedEffects: ["fill:minecraft:water"],
    costCaps: [floor(bucket, 1)], reserves: [floor(pickaxe, 1), floor(bucket, 1), floor(filled, 1)] });
  const source = { id: "o-source", verb: "fill_water", risk: "read", summary: "Witnessed source water in bucket reach",
    evidence: "The source is lit and within reach from dry footing.",
    material: { subject: "fluid:minecraft:water_source", target: "m-source", spends: { [bucket]: 1 } } } as const;
  const { material, ...readOnly } = source;
  const flowing = { ...readOnly, summary: "Flowing water without a reachable source" };
  const inventory = { [bucket]: 2, [pickaxe]: 1 };
  expect(check(inventory, [fill], [source])).toEqual({ kind: "unknown" }); // A possible fill, not awarded stock.
  expect(check(inventory, [fill], [flowing])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("sees flowing water but no witnessed source"),
  });
  expect(check(inventory, [fill])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("has no witnessed source water in reach"),
  });
  expect(check({ ...inventory, [bucket]: 1 }, [fill], [source])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("needs 2 minecraft:bucket at entry (1 to spend and 1 to retain)"),
  });
  expect(check({ [bucket]: 2 }, [fill], [source])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("cannot preserve the 1 minecraft:iron_pickaxe reserve"),
  });
  expect(check({ ...inventory, [filled]: 1 }, [fill], [source])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("no fill is needed"),
  });
});

test("Account for production batches across stages without making reachable future timber into observed stock", () => {
  const program = (logs: number, planks: number, crafts: number, requiredPlanks = planks) => [
    stage({ target: stock(log, logs), allowedEffects: [`break:${log}`], maxBreaks: logs, reserves: [floor(log, 1)] }),
    stage({ target: stock(oak, planks), allowedEffects: ["craft:oak_planks"], maxCrafts: crafts,
      costCaps: [floor(log, crafts)], reserves: [floor(log, 1)] }, [floor(log, logs)]),
    { policy: { ...pickStage().policy, reserves: [floor(log, 1), floor(oak, 4)] }, requires: [floor(oak, requiredPlanks)] },
  ];
  expect(check({ [log]: 1 }, program(4, 12, 3))).toMatchObject({
    kind: "unknown", stageIndex: 2, detail: expect.stringContaining("needs 13 minecraft:oak_planks"),
  });
  expect(check({ [log]: 5 }, program(5, 13, 4, 16))).toEqual({ kind: "possible" });
  // The corrected arithmetic does not establish that the permitted breaks are possible.
  expect(check({ [log]: 1 }, program(5, 13, 4))).toEqual({ kind: "unknown" });
  const bambooBlock = "minecraft:bamboo_block";
  const bamboo = "minecraft:bamboo_planks";
  expect(check({ [bambooBlock]: 2 }, [stage({
    target: stock(bamboo, 4), allowedEffects: ["craft:bamboo_planks"], costCaps: [floor(bambooBlock, 2)], maxCrafts: 1,
  })])).toMatchObject({ kind: "shortage", detail: expect.stringContaining("needs 2 recipe executions") });
});

test("Spent sticks are not available to a later stage even when the earlier output was a successful batch", () => {
  const stages = [
    stage({ target: stock("minecraft:torch", 8), allowedEffects: ["craft:torch"], maxCrafts: 2,
      costCaps: [floor("minecraft:coal", 2), floor(stick, 2)], reserves: [floor(table, 1)] }),
    stage({ target: pick, allowedEffects: ["craft:wooden_pickaxe"], maxCrafts: 1,
      costCaps: [floor(oak, 3), floor(stick, 2)], reserves: [floor(table, 1)] }, [floor(stick, 2)]),
  ];
  const inventory = { "minecraft:coal": 2, [stick]: 2, [oak]: 3, [table]: 1 };
  expect(check(inventory, stages, tableOffer)).toMatchObject({
    kind: "shortage", stageIndex: 1, detail: expect.stringContaining("only 0 are accounted for"),
  });
  expect(check({ ...inventory, [stick]: 4 }, stages, tableOffer)).toMatchObject({ kind: "unknown" });
});

test("Use the exact boat species but allow legitimate mixed tags in other recipes", () => {
  const recipeStages = [stage({ target: stock("minecraft:oak_boat", 1), allowedEffects: ["craft:oak_boat"],
    maxCrafts: 1, costCaps: [floor(oak, 5), floor(birch, 5)] })];
  expect(check({ [oak]: 3, [birch]: 5 }, recipeStages, tableOffer)).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("needs 5 minecraft:oak_planks"),
  });
  expect(check({ [oak]: 3, [birch]: 5 }, [stage({
    target: stock("minecraft:birch_boat", 1), allowedEffects: ["craft:birch_boat"],
    maxCrafts: 1, costCaps: [floor(birch, 5)],
  })], tableOffer)).toEqual({ kind: "possible" });
  expect(check({ [oak]: 1, [birch]: 2, [stick]: 2 }, [stage({
    target: pick, allowedEffects: ["craft:wooden_pickaxe"], maxCrafts: 1,
    costCaps: [floor(oak, 1), floor(birch, 2), floor(stick, 2)],
  })], tableOffer)).toEqual({ kind: "possible" });
});

test("Check non-wood recipes, but leave unmodeled effects and ambiguous allocation unknown", () => {
  const cobble = "minecraft:cobblestone", blackstone = "minecraft:blackstone";
  const furnace = stage({
    target: stock("minecraft:furnace", 1), allowedEffects: ["craft:furnace"],
    maxCrafts: 1, costCaps: [floor(cobble, 5), floor(blackstone, 3)],
  });
  expect(check({ [cobble]: 5, [blackstone]: 3 }, [furnace], tableOffer)).toEqual({ kind: "possible" });
  expect(check({}, [stage({
    target: stock("minecraft:bread", 1), allowedEffects: ["craft:bread"], maxCrafts: 1,
  })])).toMatchObject({ kind: "unknown" });

  const mixedPlan = [
    stage({ target: stock(stick, 4), allowedEffects: ["craft:stick"],
      maxCrafts: 1, costCaps: [floor(oak, 2), floor(birch, 2)] }),
    stage({ target: stock("minecraft:oak_boat", 1), allowedEffects: ["craft:oak_boat"],
      maxCrafts: 1, costCaps: [floor(oak, 5)] }, [floor(oak, 5)]),
  ];
  expect(check({ [oak]: 5, [birch]: 2 }, mixedPlan, tableOffer)).toMatchObject({ kind: "unknown" });
});

const rawIron = "minecraft:raw_iron";
const ingot = "minecraft:iron_ingot";
const furnace = "minecraft:furnace";
const coal = "minecraft:coal", charcoal = "minecraft:charcoal";
const smelt = `smelt:${ingot}`, placeFurnace = `place:${furnace}`;
const ironStage = (overrides: Partial<MacroWorkPolicy> = {}) => stage({
  target: stock(ingot, 3), allowedEffects: [smelt, placeFurnace],
  costCaps: [floor(rawIron, 2), floor(oak, 2), floor(furnace, 1)],
  maxCrafts: 2, maxPlacements: 1, ...overrides,
});
const caveStock = { [ingot]: 1, [rawIron]: 2, [oak]: 2, [furnace]: 1 };

test("Two held raw iron and two exact planks can provision two ingots at a newly placed furnace", () => {
  expect(check(caveStock, [ironStage()])).toEqual({ kind: "possible" });
  expect(check(caveStock, [ironStage({ maxCrafts: 1 })])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("2 smelted units"),
  });
  expect(check(caveStock, [ironStage({ allowedEffects: [], maxCrafts: 0 })]).kind).not.toBe("possible");
  expect(check(caveStock, [ironStage({ allowedEffects: [smelt], maxPlacements: 0 })])).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("no furnace placement is permitted"),
  });
});

test("Smelting cannot consume protected raw iron, exact fuel, or a protected furnace", () => {
  expect(check(caveStock, [ironStage({ reserves: [floor(rawIron, 1)] })])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("needs 3 minecraft:raw_iron at entry (2 to spend and 1 to retain)"),
  });
  expect(check(caveStock, [ironStage({ reserves: [floor(oak, 1)] })])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("only 300 ticks"),
  });
  expect(check({ ...caveStock, [coal]: 1, [birch]: 5 }, [ironStage({ costCaps: [
    floor(rawIron, 2), floor(oak, 1), floor(coal, 1), floor(furnace, 1),
  ], reserves: [floor(coal, 1)] })])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("only 300 ticks"),
  });
  expect(check(caveStock, [ironStage({ reserves: [floor(furnace, 1)] })])).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("needs 2 minecraft:furnace at entry (1 to spend and 1 to retain)"),
  });
});

test("Fuel arithmetic uses a cold start, exact counts and homogeneous batches", () => {
  const plan = (fuel: readonly MacroStockFloor[]) => ironStage({
    costCaps: [floor(rawIron, 2), floor(furnace, 1), ...fuel],
  });
  const furnaceOffer: MacroObservation["opportunities"] = [{
    id: "furnace-dry", verb: "interact", risk: "guarded", summary: `Open visible ${furnace}`,
    evidence: "A lit workstation face is inside vanilla use reach.",
  }];
  expect(check({ ...caveStock, [charcoal]: 1 }, [plan([floor(charcoal, 1)])])).toEqual({ kind: "possible" });
  expect(check({ ...caveStock, [stick]: 4 }, [plan([floor(stick, 4)])])).toEqual({ kind: "possible" });
  expect(check({ ...caveStock, [stick]: 3 }, [plan([floor(stick, 4)])], furnaceOffer)).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("only 300 ticks"),
  });
  expect(check({ ...caveStock, [birch]: 1 }, [plan([floor(oak, 1), floor(birch, 1)])])).toMatchObject({
    kind: "shortage", detail: expect.stringContaining("a single held fuel"),
  });
});

test("Crafting missing furnace equipment shares the smelt quote's craft and placement caps", () => {
  const cobble = "minecraft:cobblestone";
  const plans = (maxCrafts: number, maxPlacements: number) => [ironStage({
    allowedEffects: [smelt, placeFurnace, "craft:furnace", tablePlacement],
    costCaps: [floor(rawIron, 2), floor(oak, 2), floor(furnace, 1), floor(table, 1), floor(cobble, 8)],
    maxCrafts, maxPlacements,
  })];
  const ready = { [ingot]: 1, [rawIron]: 2, [oak]: 2, [table]: 1, [cobble]: 8 };
  expect(check(ready, plans(3, 2))).toEqual({ kind: "possible" });
  expect(check(ready, plans(3, 1), tableOffer)).toEqual({ kind: "possible" });
  expect(check(ready, plans(3, 1))).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("no placement is permitted"),
  });
  expect(check(ready, plans(2, 2))).toMatchObject({
    kind: "unknown", detail: expect.stringContaining("maxCrafts is 2"),
  });
});
