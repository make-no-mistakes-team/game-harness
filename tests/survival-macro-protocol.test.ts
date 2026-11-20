import { expect, spyOn, test } from "bun:test";
import { link, mkdtemp, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MACRO_CAPABILITIES_VERSION, MacroDirectory, MacroObservationRotating, hasDirectAuthority,
  parseMacroObservation, parseMacroProposal, parseMacroWorkOrder,
} from "../src/server/survival-macro/protocol.ts";

test("A prospect opening is a bounded dry wall clue, never a material opportunity", () => {
  const observation = {
    v: 1, run: "run", life: 1, epoch: 1, tick: 20, goal: "diamond", health: 20, food: 20, stance: 1,
    inventory: { "minecraft:iron_pickaxe": 1 }, opportunities: [], recent: [], quiescent: false,
    safety: { clear: true, revision: 1 },
  };
  const prospectOpening = { block: "minecraft:stone", target: "wall-a", tool: "minecraft:iron_pickaxe", maxToolLoss: 0 } as const;
  expect(parseMacroObservation(observation).prospectOpening).toBeUndefined();
  const live = parseMacroObservation({ ...observation, prospectOpening });
  expect(live.prospectOpening).toEqual(prospectOpening);
  expect(live.opportunities).toEqual([]);
  expect(hasDirectAuthority({
    kind: "continuation", opportunityId: prospectOpening.target, reserves: [],
    steps: [{ selector: { verb: "break", subject: "block:minecraft:stone" }, maxEffects: 1, until: null }],
  }, live, MACRO_CAPABILITIES_VERSION)).toBe(false);
  for (const invalid of [
    { ...prospectOpening, block: "minecraft:water" },
    { ...prospectOpening, block: "minecraft:furnace" },
    { ...prospectOpening, block: "minecraft:diamond_ore" },
    { ...prospectOpening, maxToolLoss: 2 },
    { ...prospectOpening, verb: "break" },
  ]) expect(() => parseMacroObservation({ ...observation, prospectOpening: invalid })).toThrow("prospect opening");
  expect(() => parseMacroObservation({ ...observation, prospectOpening,
    safety: { clear: false, revision: 2 } })).toThrow("prospect opening scope");
});

test("Only supported near-term footing can carry a travel clue, never native input", () => {
  const observation = {
    v: 1, run: "run", life: 1, epoch: 1, tick: 20, goal: "diamond", health: 20, food: 20, stance: 1,
    inventory: {}, opportunities: [], recent: [], quiescent: false, safety: { clear: true, revision: 1 },
  };
  const travelHint = { kind: "resource", subject: "block:minecraft:iron_ore", target: "vein-a",
    footing: "shallow_water_with_bank", bearingDegrees: -8, windowBlocks: 0.7 } as const;
  const live = parseMacroObservation({ ...observation, travelHint });
  expect(live.travelHint).toEqual(travelHint);
  expect(live.opportunities).toEqual([]);
  expect(hasDirectAuthority({ kind: "continuation", opportunityId: travelHint.target, reserves: [],
    steps: [{ selector: { verb: "break", subject: travelHint.subject }, maxEffects: 1, until: null }],
  }, live, MACRO_CAPABILITIES_VERSION)).toBe(false);
  for (const unsupported of [
    { ...travelHint, footing: "deep_water" }, { ...travelHint, footing: "drop" }, { ...travelHint, footing: "unseen" },
    { ...travelHint, windowBlocks: 0 }, { ...travelHint, windowBlocks: 80 }, { ...travelHint, opportunityId: "walk" },
    { ...travelHint, kind: "cave_frontier" }, { ...travelHint, bearingDegrees: 181 },
  ]) expect(() => parseMacroObservation({ ...observation, travelHint: unsupported })).toThrow("travel hint");
  expect(() => parseMacroObservation({ ...observation, travelHint,
    safety: { clear: false, revision: 2 } })).toThrow("travel hint scope");
});

test("A work approach names one target without pricing its material", () => {
  const travelAnchor = { subject: "block:minecraft:stone", target: "wall-a" };
  const order = {
    v: 1, id: "iron-leg", run: "run", life: 1, epoch: 1, basisTick: 10, expiresTick: 100,
    safetyRevision: 1, origin: "model", target: { kind: "stock", item: "minecraft:raw_iron", count: 1 },
    allowedEffects: ["break:minecraft:iron_ore"], costCaps: [], reserves: [], maxBreaks: 2, maxCrafts: 0, maxPlacements: 0,
    travelAnchor,
  };
  expect(parseMacroWorkOrder(order)).toMatchObject({ travelAnchor, allowedEffects: ["break:minecraft:iron_ore"] });
  expect(() => parseMacroWorkOrder({ ...order, maxBreaks: 0 })).toThrow("work travel anchor scope");
  expect(() => parseMacroWorkOrder({ ...order, duringWaitFor: "paid-iron" })).toThrow("work travel anchor scope");
  expect(() => parseMacroWorkOrder({ ...order, travelAnchor: { ...travelAnchor, target: "../ore" } })).toThrow("travel anchor target");
  expect(() => parseMacroWorkOrder({ ...order, travelAnchor: { ...travelAnchor, subject: "block:minecraft:oak_log" } }))
    .toThrow("work travel anchor scope");
});

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

test("Renewal accepts only an exact job ID and the proposal's finite expiry", () => {
  const lease = { action: { kind: "renew-work", workOrderId: "active-job" }, expiresTick: 300,
    subgoal: "Finish the prospect", reason: "Dry path remains", successCondition: "One diamond is held",
    contingency: "Stop at water", alternative: "Return to the furnace" } as const;
  expect(parseMacroProposal(lease).action).toEqual(lease.action);
  for (const field of ["policy", "afterWorkId", "duringWaitFor", "maxPlacements", "expiresTick"])
    expect(() => parseMacroProposal({ ...lease, action: { ...lease.action, [field]: 1 } })).toThrow("renew-work");
  expect(() => parseMacroProposal({ ...lease, expiresTick: Infinity })).toThrow("proposal expiry");
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
  const observation = {
    v: 1, run: "run", life: 1, epoch: 1, tick: 20, goal: "diamond", health: 20, food: 20,
    inventory: { [target.item]: 1 }, opportunities: [], recent: [], quiescent: false,
    workOrder: { id: order.id, state: "working", detail: "Waiting for furnace output", progress },
  };
  expect(parseMacroObservation(observation).workOrder).toMatchObject({
    state: "working", progress: { phase: "smelt", crafts: 0, target: { count: 1, required: 3 } },
  });
  const burn = { burnTick: 19, units: 2, remainingCookTicks: 398 };
  const withBurn = (phase: string, cue: typeof burn) => parseMacroObservation({
    ...observation, workOrder: { ...observation.workOrder, progress: { ...progress, phase, smeltBurn: cue } },
  });
  expect(withBurn("smelt", burn)).toMatchObject({
    inventory: { [target.item]: 1 }, workOrder: { progress: { smeltBurn: burn } },
  });
  expect(() => withBurn("hold", burn)).toThrow();
  expect(() => withBurn("smelt", { ...burn, burnTick: 21 })).toThrow();
  expect(() => withBurn("smelt", { ...burn, remainingCookTicks: 401 })).toThrow();
});

test("Pending stock is not inventory or a permission to spend, replace, or renew production", () => {
  const ticket = {
    id: "paid-batch", kind: "iron-smelting", goal: "diamond", invested: [
      { item: "minecraft:raw_iron", count: 2 }, { item: "minecraft:coal", count: 1 },
    ], output: { item: "minecraft:iron_ingot", count: 2 }, location: "Dry workshop", state: "estimated",
    remainingTicks: 350, parked: false, yieldable: true,
  };
  const sample = {
    v: 1, tick: 60, life: 1, epoch: 1, run: "run", goal: "diamond", health: 20, food: 20,
    quiescent: false, inventory: { "minecraft:iron_ingot": 1 }, opportunities: [], recent: [],
    safety: { clear: true, revision: 1 }, workOrder: { id: ticket.id, state: "working", detail: "Cooking" },
    pendingWork: ticket,
  };
  expect(parseMacroObservation(sample)).toMatchObject({
    inventory: { "minecraft:iron_ingot": 1 }, pendingWork: { output: ticket.output, invested: ticket.invested },
  });
  expect(() => parseMacroObservation({ ...sample, pendingWork: { ...ticket, collectOfferId: "made-up" } })).toThrow("pending work opportunity");
  expect(() => parseMacroObservation({ ...sample, working: { intentId: "held-mouse", crack: 0.2 } })).toThrow("pending work scope");
  expect(() => parseMacroObservation({ ...sample, pendingWork: { ...ticket, historical: true } })).toThrow("pending work scope");
  const cave = { id: "dry-cave-edge", verb: "follow", risk: "guarded", summary: "One returnable cave edge", evidence: "Dry both ways." };
  const recall = { id: "fresh-recall", verb: "collect_pending", risk: "guarded", summary: "Recall exact furnace", evidence: "Same workshop trail." };
  const worksite = { routes: "Paired level edge ahead; no movement yet." };
  const protectedReserves = [{ item: "minecraft:oak_planks", count: 1 }];
  const parked = { ...sample, workOrder: { ...sample.workOrder, state: "complete" },
    pendingWork: { ...ticket, parked: true, yieldable: false, collectOfferId: recall.id, worksite,
      returnClue: "walked_route", protectedReserves },
    opportunities: [recall, cave] };
  expect(parseMacroObservation(parked).pendingWork).toMatchObject({ worksite, returnClue: "walked_route", protectedReserves });
  expect(() => parseMacroObservation({ ...parked, opportunities: [recall, { ...cave, risk: "low" }] }))
    .toThrow("unscoped low-risk dry follow");
  expect(() => parseMacroObservation({ ...parked, workOrder: sample.workOrder })).toThrow("pending work operation");
  const moving = { ...parked, workOrder: { ...sample.workOrder, id: "ordinary-job" }, opportunities: [],
    pendingWork: { ...parked.pendingWork, worksite: undefined, collectOfferId: undefined } };
  expect(parseMacroObservation(moving).pendingWork).toMatchObject({ returnClue: "walked_route" });
  expect(parseMacroObservation(moving).pendingWork?.collectOfferId).toBeUndefined();
  const side = {
    target: { kind: "stock", item: "minecraft:cobblestone", count: 12 }, allowedEffects: ["break:minecraft:stone", "place:minecraft:crafting_table"],
    costCaps: [{ item: "minecraft:crafting_table", count: 1 }], reserves: [], maxBreaks: 12, maxCrafts: 0, maxPlacements: 1,
  };
  const order = { v: 1, id: "side-stock", run: "run", life: 1, epoch: 1, safetyRevision: 1,
    basisTick: 60, expiresTick: 1260, origin: "model", duringWaitFor: ticket.id, ...side };
  expect(parseMacroWorkOrder(order).duringWaitFor).toBe(ticket.id);
  expect(() => parseMacroWorkOrder({ ...order, expiresTick: 1261 })).toThrow("work expiry");
  expect(() => parseMacroWorkOrder({ ...order, target: { ...side.target, item: ticket.output.item } })).toThrow("independent pending work");
  const proposal = { subgoal: "Build useful cave stock", reason: "Visible stone", successCondition: "Two real cobblestone",
    contingency: "Stop on risk", alternative: "Wait for the kitchen", expiresTick: 660 };
  expect(() => parseMacroProposal({ ...proposal, action: { kind: "work", policy: side,
    duringWaitFor: ticket.id, afterWorkId: ticket.id } })).toThrow("exclusive work relationship");
  expect(parseMacroProposal({ ...proposal, action: { kind: "work", policy: side, openingViewId: "cave-view" } })
    .action).toMatchObject({ openingViewId: "cave-view" });
  for (const relationship of [{ duringWaitFor: ticket.id }, { afterWorkId: ticket.id }]) {
    expect(() => parseMacroProposal({ ...proposal, action: { kind: "work", policy: side,
      openingViewId: "cave-view", ...relationship } })).toThrow("exclusive work relationship");
  }
  expect(() => parseMacroProposal({ ...proposal, action: { kind: "skill", candidate: { source: "pass", parentGeneration: 0,
    verbs: ["survey"], duringWaitFor: ticket.id } } })).toThrow();
});

test("Deep diamond work is explicit, standalone, and does not imply cover or torches", () => {
  const explore = "prospect:minecraft:diamond", ore = "break:minecraft:deepslate_diamond_ore";
  const torch = "place:minecraft:torch";
  const policy = { target: { kind: "stock", item: "minecraft:diamond", count: 1 },
    allowedEffects: [explore, ore], maxBreaks: 8, maxCrafts: 0, maxPlacements: 0, costCaps: [], reserves: [] };
  const order = { ...policy, v: 1, id: "diamond-leg", run: "run", life: 1, epoch: 1, basisTick: 10,
    expiresTick: 1210, safetyRevision: 1, origin: "model" };
  const proposal = (action: unknown) => ({ action, subgoal: "Explore for diamond", reason: "Dry cave",
    successCondition: "Diamond held", contingency: "Stop at unsafe rock", alternative: "Inspect a lower shelf", expiresTick: 1210 });
  expect(parseMacroProposal(proposal({ kind: "work", policy })).action).toMatchObject({ kind: "work",
    policy: { allowedEffects: [ore, explore] } });
  expect(parseMacroWorkOrder({ ...order, allowedEffects: [ore] }).allowedEffects).toEqual([ore]);
  expect(parseMacroWorkOrder(order).allowedEffects).toEqual([ore, explore]);
  expect(parseMacroWorkOrder({ ...order, allowedEffects: [explore, ore, torch], maxPlacements: 1,
    costCaps: [{ item: "minecraft:torch", count: 1 }] }).maxPlacements).toBe(1);
  const cobble = "place:minecraft:cobblestone";
  const support = { ...order, allowedEffects: [explore, ore, cobble], maxPlacements: 1,
    costCaps: [{ item: "minecraft:cobblestone", count: 1 }], reserves: [{ item: "minecraft:cobblestone", count: 2 }] };
  expect(parseMacroWorkOrder(support)).toMatchObject({ maxPlacements: 1, allowedEffects: [ore, cobble, explore] });
  for (const invalid of [
    { ...order, origin: "preset" }, { ...order, id: "work:3" }, { ...order, allowedEffects: [explore] },
    { ...order, target: { kind: "stock", item: "minecraft:iron_ingot", count: 1 } },
    { ...order, allowedEffects: [ore, torch] }, { ...order, maxBreaks: 0 },
    { ...order, allowedEffects: [explore, ore, torch], maxPlacements: 1 },
    { ...support, allowedEffects: [ore, cobble] }, { ...support, costCaps: [{ item: "minecraft:torch", count: 1 }] },
    { ...support, maxPlacements: 0 }, { ...support, id: "work:2" },
  ]) expect(() => parseMacroWorkOrder(invalid)).toThrow();
  expect(() => parseMacroProposal(proposal({
    kind: "work-program", stages: [{ policy, requires: [] }, {
      policy: { ...policy, target: { kind: "stock", item: "minecraft:torch", count: 4 }, allowedEffects: [] }, requires: [],
    }],
  }))).toThrow("single live work policy");
});

test("Only a single exact live order can fill a water bucket", () => {
  const target = { kind: "stock", item: "minecraft:water_bucket", count: 1 };
  const costCaps = [{ item: "minecraft:bucket", count: 1 }];
  const policy = { target, allowedEffects: ["fill:minecraft:water"], costCaps,
    reserves: [{ item: "minecraft:iron_pickaxe", count: 1 }], maxBreaks: 0, maxCrafts: 0, maxPlacements: 0 };
  const order = { ...policy, v: 1, id: "water-work", run: "run", life: 1, epoch: 1, basisTick: 10,
    expiresTick: 100, safetyRevision: 1, origin: "model" };
  const proposal = (action: unknown) => ({ action, subgoal: "Fill the empty bucket", reason: "A reachable source is witnessed",
    successCondition: "Matching use and inventory swap", contingency: "Stop if the source changes",
    alternative: "Keep the empty bucket", expiresTick: 100 });
  expect(parseMacroWorkOrder(order)).toMatchObject(policy);
  expect(parseMacroProposal(proposal({ kind: "work", policy })).action.kind).toBe("work");
  for (const invalid of [
    { origin: "preset" }, { id: "work:3" }, { id: "work:1", nextWorkId: "work:2" },
    { target: { ...target, count: 2 } }, { target: { ...target, item: "minecraft:lava_bucket" } },
    { allowedEffects: ["fill:minecraft:lava"] }, { allowedEffects: ["pour:minecraft:water"] },
    { allowedEffects: ["place:minecraft:water"] }, { allowedEffects: [...policy.allowedEffects, "craft:bucket"] },
    { costCaps: [] }, { costCaps: [{ ...costCaps[0], count: 2 }] },
    { costCaps: [{ item: "minecraft:water_bucket", count: 1 }] },
    { costCaps: [...costCaps, { item: "minecraft:dirt", count: 1 }] },
    { maxBreaks: 1 }, { maxCrafts: 1 }, { maxPlacements: 1 },
  ]) expect(() => parseMacroWorkOrder({ ...order, ...invalid })).toThrow();
  expect(() => parseMacroProposal(proposal({ kind: "work-program", stages: [
    { policy, requires: [] },
    { policy: { ...policy, target: { ...target, item: "minecraft:bucket" }, allowedEffects: [], costCaps: [] }, requires: [] },
  ] }))).toThrow("single live work policy");
  expect(() => parseMacroProposal(proposal({ kind: "continuation", opportunityId: "o-water", reserves: [], steps: [
    { selector: { verb: "fill_water", subject: "fluid:minecraft:water_source" }, maxEffects: 1, until: null },
  ] }))).toThrow();
});

test("A water offer is read-only and names only the exact witnessed source and bucket spend", () => {
  const clue = { id: "o-water", verb: "fill_water", risk: "read", summary: "Witnessed source water in bucket reach",
    evidence: "A lit source-water surface is visible from this dry stance." };
  const material = { subject: "fluid:minecraft:water_source", target: "m-water", spends: { "minecraft:bucket": 1 } };
  const observation = (offer: unknown) => ({
    v: 1, run: "run", life: 1, epoch: 1, tick: 20, goal: "diamond", health: 20, food: 20,
    inventory: { "minecraft:bucket": 1 }, opportunities: [offer], recent: [], quiescent: true,
  });
  expect(parseMacroObservation(observation({ ...clue, material })).opportunities[0]).toMatchObject({
    verb: "fill_water", risk: "read", material: { subject: "fluid:minecraft:water_source", spends: { "minecraft:bucket": 1 } },
  });
  expect(parseMacroObservation(observation({ ...clue, summary: "Flowing water without a reachable source" }))
    .opportunities[0]?.material).toBeUndefined();
  for (const offer of [
    { ...clue, risk: "guarded", material }, { ...clue, risk: "low" },
    { ...clue, material: { ...material, subject: "fluid:minecraft:lava_source" } },
    { ...clue, material: { ...material, subject: "fluid:minecraft:flowing_water" } },
    { ...clue, material: { ...material, spends: {} } },
    { ...clue, material: { ...material, spends: { "minecraft:bucket": 2 } } },
    { ...clue, material: { ...material, spends: { "minecraft:lava_bucket": 1 } } },
  ]) expect(() => parseMacroObservation(observation(offer))).toThrow();
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
