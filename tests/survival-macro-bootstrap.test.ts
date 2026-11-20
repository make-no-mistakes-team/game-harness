import { expect, test } from "bun:test";
import { access, appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewPauseJournal } from "../survival-agent/pause-evidence.ts";
import {
  bindFirstPlan, firstPlanContext, parseFirstPlanToolArguments, PRE_SPAWN_GOAL_ONLY, type FirstPlanInference,
  type FirstPlanRequest, type FirstPlanStrategist,
} from "../src/server/survival-macro/bootstrap.ts";
import { composeTerraSurvival, declareTerraStrategy } from "../src/server/survival-macro/compose.ts";
import { SurvivalMacroController } from "../src/server/survival-macro/controller.ts";
import { parseMacroWorkOrder, type MacroObservation, type MacroOpportunity, type MacroReceipt } from "../src/server/survival-macro/protocol.ts";
import { TERRA_MODEL_ID } from "../src/shared/survival-agent-ui.ts";

const GOAL = "stone_pickaxe";
const plankBranch = {
  policy: { kind: "plank_stock", source: "witnessed_timber", count: 4, maxBreaks: 1, maxCrafts: 1 },
  requires: [],
} as const;
const planks = {
  kind: "first_policy",
  branches: [plankBranch], reserves: [],
} as const;

function offer(id: string, verb: "break" | "continue" | "collect", subject: string, spends = {}): MacroOpportunity {
  return { id, verb, summary: "Observed native opportunity", evidence: "Witnessed by the native actor",
    risk: "guarded", material: { subject, target: `target-${id}`, spends } };
}

const spruce = offer("spruce-face", "break", "block:minecraft:spruce_log");
const birch = offer("birch-face", "break", "block:minecraft:birch_log");

function view(change: Partial<MacroObservation> = {}): MacroObservation {
  return { v: 1, run: "run", life: 1, epoch: 1, tick: 5, goal: GOAL, health: 20, food: 20,
    inventory: {}, opportunities: [], recent: [], quiescent: true, safety: { clear: true, revision: 1 }, ...change };
}

const request = { goal: GOAL } as const;
const liveScope = { run: "run", first: view(), protectedReserves: [] };

test("goal-only context cannot serialize a player, frame, observation, source files, private run ID, or world data", () => {
  const untrusted = {
    ...request, objective: "Keep one spruce log", run: "private-run", seed: "private-seed",
    frame: "private-image", observation: view({ inventory: { "minecraft:spruce_log": 8 } }),
  };
  const context = firstPlanContext(untrusted);
  expect(context?.messages[0]?.content).toBe('{"goal":"stone_pickaxe","objective":"Keep one spruce log"}');
  expect(JSON.stringify(context)).not.toContain("private-");
  expect(context?.tools?.map(tool => tool.name)).toEqual(["propose_survival_first_plan"]);
  expect(JSON.stringify(context?.tools)).not.toContain("smelt:minecraft:iron_ingot");
  expect(JSON.stringify(context?.tools)).not.toContain("place:minecraft:furnace");
});

test("only exact bounded advisory and defer schemas are admitted", () => {
  expect(parseFirstPlanToolArguments('{"advice":{"kind":"defer"}}')).toEqual({ kind: "defer" });
  expect(parseFirstPlanToolArguments(JSON.stringify({ advice: planks }))).toEqual(planks);
  expect(parseFirstPlanToolArguments('{"advice":{"kind":"defer"}')).toBeNull();
  for (const raw of [
    { ...planks, basis: view() },
    { ...planks, branches: [] },
    { ...planks, branches: [plankBranch, plankBranch, plankBranch, plankBranch] },
    { ...planks, branches: [{ ...plankBranch, policy: { ...plankBranch.policy, maxCrafts: 3 } }] },
    { ...planks, branches: [{ ...plankBranch, policy: { ...plankBranch.policy, source: "minecraft:any_log" } }] },
    { ...planks, branches: [{ ...plankBranch, policy: { ...plankBranch.policy, source: "minecraft:air" } }] },
    { ...planks, branches: [{ ...plankBranch, policy: { ...plankBranch.policy, code: "export function act() {}" } }] },
    { ...planks, branches: [{ ...plankBranch, reserves: [] }] },
    { ...planks, reserves: [{ item: "minecraft:air", count: 1 }] },
    { ...planks, branches: [{ ...plankBranch,
      requires: [{ item: "minecraft:coal", count: 1 }, { item: "minecraft:coal", count: 2 }] }] },
    { kind: "defer", reason: "Pretend I saw a tree" },
  ]) expect(parseFirstPlanToolArguments(JSON.stringify({ advice: raw }))).toBeNull();
});

test("witnessed timber binds exact live species and spend; absent, mismatched or ambiguous evidence does not", () => {
  expect(bindFirstPlan(request, planks, view(), liveScope)).toEqual({ reason: "no_matching_live_material" });
  expect(bindFirstPlan(request, planks, view({ opportunities: [spruce] }), liveScope)).toMatchObject({
    policy: {
      target: { kind: "stock", item: "minecraft:spruce_planks", count: 4 },
      allowedEffects: ["break:minecraft:spruce_log", "craft:spruce_planks"],
      costCaps: [{ item: "minecraft:spruce_log", count: 1 }],
      maxBreaks: 1, maxCrafts: 1, maxPlacements: 0,
    },
  });
  const specific = { ...planks, branches: [{ ...plankBranch, policy: { ...plankBranch.policy, source: "minecraft:oak_log" } }] };
  expect(bindFirstPlan(request, specific, view({ opportunities: [birch] }), liveScope)).toEqual({
    reason: "no_matching_live_material",
  });
  expect(bindFirstPlan(request, planks, view({ opportunities: [spruce, birch] }), liveScope)).toEqual({
    reason: "ambiguous_material_binding",
  });
  expect(bindFirstPlan(request, planks, view({ opportunities: [
    offer("risk", "break", "block:minecraft:spruce_log", { "minecraft:wooden_axe": 1 }),
  ] }), liveScope)).toEqual({ reason: "no_matching_live_material" });
});

test("stock and recipe evidence must agree, and planks cannot consume protected logs", () => {
  const log = "minecraft:stripped_dark_oak_wood";
  const reserve = { item: log, count: 2 };
  const observation = view({
    inventory: { [log]: 3 },
    opportunities: [offer("recipe", "continue", "recipe:planks", { [log]: 1 })],
  });
  const scope = { ...liveScope, first: observation };
  expect(bindFirstPlan(request, { ...planks, reserves: [reserve] }, observation, scope)).toMatchObject({
    policy: {
      target: { kind: "stock", item: "minecraft:dark_oak_planks", count: 4 },
      allowedEffects: ["craft:dark_oak_planks"], maxBreaks: 0, maxCrafts: 1,
      costCaps: [{ item: log, count: 1 }], reserves: [reserve],
    },
  });
  expect(bindFirstPlan(request, { ...planks, reserves: [reserve] },
    { ...observation, inventory: { [log]: 2 } }, scope)).toEqual({ reason: "no_matching_live_material" });
  expect(bindFirstPlan(request, planks, { ...observation, opportunities: [] }, liveScope)).toEqual({
    reason: "no_matching_live_material",
  });
});

test("stone is bound to cobblestone only when seen as an actually harvestable exact effect", () => {
  const stone = { kind: "first_policy", branches: [{ policy: { kind: "harvest_stock", resource: "minecraft:cobblestone",
    count: 2, maxBreaks: 3 }, requires: [{ item: "minecraft:wooden_pickaxe", count: 1 }] }], reserves: [] } as const;
  const seen = view({ inventory: { "minecraft:wooden_pickaxe": 1 },
    opportunities: [offer("face", "break", "block:minecraft:stone")] });
  const scope = { ...liveScope, first: seen };
  expect(bindFirstPlan(request, stone, seen, scope)).toMatchObject({
    policy: { target: { kind: "stock", item: "minecraft:cobblestone", count: 2 },
      allowedEffects: ["break:minecraft:stone"], costCaps: [], maxBreaks: 3, maxCrafts: 0, maxPlacements: 0 },
  });
  expect(bindFirstPlan(request, stone, { ...seen, inventory: {} }, scope)).toEqual({ reason: "stock_prerequisite_missing" });
});

const reserveLog = { item: "minecraft:spruce_log", count: 1 };
const boundSource = { kind: "bound_source" } as const;
const boundPlanks = { kind: "bound_planks" } as const;
const boundReserve = { item: boundSource, count: 1 } as const;
const recipe = offer("recipe", "continue", "recipe:planks", { [reserveLog.item]: 1 });
const stocked = {
  policy: { ...plankBranch.policy, source: reserveLog.item, maxBreaks: 0 },
  requires: [{ ...reserveLog, count: 2 }],
} as const;
const alternatives = { ...planks, reserves: [reserveLog], branches: [stocked, plankBranch] } as const;

function stockStage(item: string | typeof boundPlanks, count: number, requires: readonly unknown[],
  allowedEffects: readonly unknown[], costCaps: readonly unknown[], reserves: readonly unknown[],
  maxCrafts: number, maxPlacements = 0) {
  return { requires, policy: { target: { kind: "stock", item, count }, allowedEffects, costCaps, reserves,
    maxBreaks: 0, maxCrafts, maxPlacements } };
}

const timberProgram = {
  kind: "first_policy", reserves: [boundReserve],
  branches: [{
    policy: { kind: "harvest_stock", resource: "witnessed_log", count: 4, maxBreaks: 4 }, requires: [],
    then: [
      stockStage(boundPlanks, 12, [{ item: boundSource, count: 4 }], [{ kind: "craft_bound_planks" }],
        [{ item: boundSource, count: 3 }], [{ item: boundPlanks, count: 4 }], 3),
      stockStage("minecraft:wooden_axe", 1, [{ item: boundPlanks, count: 12 }],
        ["craft:wooden_axe", "craft:stick", "craft:crafting_table", "place:minecraft:crafting_table"],
        [{ item: boundPlanks, count: 8 }, { item: "minecraft:stick", count: 2 }, { item: "minecraft:crafting_table", count: 1 }],
        [], 3, 1),
    ],
  }],
} as const;

function openingAdvice(advice: unknown) {
  const parsed = parseFirstPlanToolArguments(JSON.stringify({ advice }));
  if (!parsed) throw new Error("Invalid opening fixture.");
  return parsed;
}

const pickRequest = { goal: "wooden_pickaxe" } as const;
const pick = "minecraft:wooden_pickaxe";
// The ordinary fqHNB3 reply: a three-timber acquisition checkpoint, followed by all six crafts and one placement.
const heldTimberBranch = {
  policy: { kind: "harvest_stock", resource: "witnessed_timber", count: 3, maxBreaks: 3 },
  requires: [],
  then: [stockStage(pick, 1, [{ item: boundSource, count: 3 }],
    [{ kind: "craft_bound_planks" }, "craft:crafting_table", "place:minecraft:crafting_table", "craft:stick", "craft:wooden_pickaxe"],
    [{ item: boundSource, count: 3 }, { item: boundPlanks, count: 9 },
      { item: "minecraft:stick", count: 2 }, { item: "minecraft:crafting_table", count: 1 }], [], 6, 1)],
} as const;
const heldTimberAdvice = openingAdvice({ kind: "first_policy", branches: [heldTimberBranch], reserves: [] });
const footing = { id: "flat", verb: "approach", risk: "low", summary: "Walk to the adjacent flat tile",
  evidence: "Lit full top and clear dry sweep, left of center from the current view." } as const;

function heldTimber(source: string, count = 3) {
  return view({ goal: pickRequest.goal, inventory: { [source]: count }, opportunities: [
    footing, offer("grid", "continue", "recipe:planks", { [source]: 1 }),
  ] });
}

test.each(["oak", "birch"])("held %s timber makes the ordinary pick suffix executable without any harvest offer", species => {
  const source = `minecraft:${species}_log`;
  const live = heldTimber(source);
  expect(bindFirstPlan(pickRequest, heldTimberAdvice, live, { ...liveScope, first: live })).toMatchObject({
    input: source, stockSatisfied: [{ item: source, count: 3 }],
    policy: { target: { item: pick, count: 1 }, maxBreaks: 0, maxCrafts: 6, maxPlacements: 1,
      allowedEffects: [`craft:${species}_planks`, "craft:crafting_table", "craft:stick",
        "craft:wooden_pickaxe", "place:minecraft:crafting_table"].sort(),
    },
  });
});

test("a held timber checkpoint cannot sum species, spend a retained floor, or replace grid and site evidence", () => {
  const source = "minecraft:oak_log";
  const live = heldTimber(source);
  const bind = (sample: MacroObservation, first = sample, advice = heldTimberAdvice) =>
    bindFirstPlan(pickRequest, advice, sample, { ...liveScope, first });
  expect(bind({ ...live, inventory: { [source]: 2, "minecraft:birch_log": 1 } }))
    .toEqual({ reason: "no_matching_live_material" });
  expect(bind({ ...live, inventory: { ...live.inventory, "minecraft:birch_log": 3 } }))
    .toEqual({ reason: "ambiguous_material_binding" });
  expect(bind(live, { ...live, inventory: {} })).toHaveProperty("reason");
  expect(bind({ ...live, opportunities: [footing, spruce] })).toHaveProperty("reason");
  expect(bind({ ...live, opportunities: live.opportunities.slice(1) })).toHaveProperty("reason");
  expect(bind(live, live, openingAdvice({ kind: "first_policy", branches: [heldTimberBranch], reserves: [boundReserve] })))
    .toHaveProperty("reason");
  expect(bind({ ...live, inventory: { ...live.inventory, [pick]: 1 } })).toEqual({ reason: "opening_target_already_held" });
});

test("a symbolic plank stock can prove its exact species directly from held planks, not imaginary logs", () => {
  const plank = "minecraft:spruce_planks";
  const branch = { ...plankBranch, then: [
    stockStage("minecraft:stick", 4, [{ item: boundPlanks, count: 4 }], ["craft:stick"],
      [{ item: boundPlanks, count: 2 }], [], 1),
  ] };
  const live = view({ inventory: { [plank]: 4 }, opportunities: [
    offer("sticks", "continue", "recipe:stick", { [plank]: 2 }),
  ] });
  expect(bindFirstPlan(request, openingAdvice({ ...planks, branches: [branch] }), live, { ...liveScope, first: live }))
    .toMatchObject({ input: plank, stockSatisfied: [{ item: plank, count: 4 }],
      policy: { target: { item: "minecraft:stick", count: 4 }, allowedEffects: ["craft:stick"], maxBreaks: 0,
        costCaps: [{ item: plank, count: 2 }] } });
  expect(bindFirstPlan(request, openingAdvice({ ...planks, branches: [branch], reserves: [boundReserve] }),
    live, { ...liveScope, first: live })).toHaveProperty("reason");
});

test("a carried table is not usable until an authorized and witnessed placement can start", () => {
  const plank = "minecraft:oak_planks", stick = "minecraft:stick", table = "minecraft:crafting_table";
  const costs = [{ item: plank, count: 3 }, { item: stick, count: 2 }, { item: table, count: 1 }];
  const branch = { ...plankBranch, then: [
    stockStage(pick, 1, [{ item: boundPlanks, count: 4 }],
      ["craft:wooden_pickaxe", "place:minecraft:crafting_table"], costs, [], 1, 1),
  ] };
  const advice = openingAdvice({ ...planks, branches: [branch] });
  const live = view({ goal: pickRequest.goal, inventory: { [plank]: 4, [stick]: 2, [table]: 1 }, opportunities: [footing] });
  expect(bindFirstPlan(pickRequest, advice, live, { ...liveScope, first: live })).toMatchObject({
    liveTargets: [footing.id], policy: { maxPlacements: 1, allowedEffects: ["craft:wooden_pickaxe", "place:minecraft:crafting_table"] },
  });
  for (const opportunities of [[], [{ ...footing, evidence: "Unwitnessed footing" }], [{
    id: "clue", verb: "survey", risk: "read", summary: `Reacquire recent ${table}`, evidence: "Not currently witnessed.",
  }]] as const) expect(bindFirstPlan(pickRequest, advice, { ...live, opportunities }, { ...liveScope, first: live }))
    .toHaveProperty("reason");
  const unpermitted = openingAdvice({ ...planks, branches: [{ ...branch, then: [
    stockStage(pick, 1, [{ item: boundPlanks, count: 4 }], ["craft:wooden_pickaxe"], costs.slice(0, 2), [], 1),
  ] }] });
  expect(bindFirstPlan(pickRequest, unpermitted, live, { ...liveScope, first: live })).toHaveProperty("reason");
  const visibleTable = view({ ...live, opportunities: [{ id: "table", verb: "interact", risk: "guarded",
    summary: `Open visible ${table}`, evidence: "A lit workstation face is inside vanilla use reach." }] });
  expect(bindFirstPlan(pickRequest, unpermitted, visibleTable, { ...liveScope, first: visibleTable })).toMatchObject({
    liveTargets: ["table"], policy: { maxPlacements: 0 },
  });
});

test("consecutive held checkpoints grant no effects and preserve the next stage's exact costs", () => {
  const source = "minecraft:oak_log", plank = "minecraft:oak_planks";
  const advice = openingAdvice({ kind: "first_policy", reserves: [], branches: [{
    ...heldTimberBranch, then: [
      stockStage(boundPlanks, 12, [{ item: boundSource, count: 3 }], [{ kind: "craft_bound_planks" }],
        [{ item: boundSource, count: 3 }], [], 3),
      stockStage("minecraft:stick", 4, [{ item: boundPlanks, count: 12 }], ["craft:stick"],
        [{ item: boundPlanks, count: 2 }], [], 1),
    ],
  }] });
  const live = view({ inventory: { [source]: 3, [plank]: 12 }, opportunities: [
    offer("sticks", "continue", "recipe:stick", { [plank]: 2 }),
  ] });
  expect(bindFirstPlan(request, advice, live, { ...liveScope, first: live })).toMatchObject({
    stockSatisfied: [{ item: source, count: 3 }, { item: plank, count: 12 }], then: [],
    policy: { target: { item: "minecraft:stick", count: 4 }, allowedEffects: ["craft:stick"], maxBreaks: 0,
      maxCrafts: 1, costCaps: [{ item: plank, count: 2 }] },
  });
});

test("one conditional timber program resolves exact stock and craft references for different actual species", () => {
  const advice = openingAdvice(timberProgram);
  for (const [source, output, visible] of [
    ["minecraft:spruce_log", "minecraft:spruce_planks", spruce],
    ["minecraft:birch_log", "minecraft:birch_planks", birch],
  ] as const) {
    expect(bindFirstPlan(request, advice, view({ opportunities: [visible] }), liveScope)).toMatchObject({
      input: source,
      then: [
        { requires: [{ item: source, count: 4 }], policy: {
          target: { item: output, count: 12 }, costCaps: [{ item: source, count: 3 }],
          allowedEffects: [`craft:${output.split(":")[1]}`], maxCrafts: 3,
        } },
        { requires: [{ item: output, count: 12 }], policy: {
          target: { item: "minecraft:wooden_axe", count: 1 },
          reserves: expect.arrayContaining([{ item: source, count: 1 }, { item: output, count: 4 }]),
        } },
      ],
    });
  }
  expect(bindFirstPlan(request, advice, view({ opportunities: [spruce, birch] }), liveScope)).toEqual({
    reason: "ambiguous_material_binding",
  });
});

test("conditional stock references resolve to coal or cobblestone, not speculative block IDs or planks", () => {
  for (const [source, block, target] of [
    ["minecraft:coal", "minecraft:deepslate_coal_ore", "minecraft:torch"],
    ["minecraft:cobblestone", "minecraft:stone", "minecraft:stone_shovel"],
  ] as const) {
    const first = { policy: { kind: "harvest_stock", resource: source, count: 2, maxBreaks: 2 }, requires: [] };
    const visible = view({ opportunities: [offer("face", "break", `block:${block}`)] });
    const stage = stockStage(target, 1, [{ item: boundSource, count: 2 }], [`craft:${target.slice(10)}`],
      [{ item: boundSource, count: 1 }, { item: "minecraft:stick", count: 2 }], [], 1);
    const plan = openingAdvice({ kind: "first_policy", reserves: [boundReserve], branches: [{ ...first, then: [stage] }] });
    const rich = { ...visible, inventory: { [source]: 1 } };
    expect(bindFirstPlan(request, plan, rich, { ...liveScope, first: rich })).toMatchObject({
      input: source, then: [{ requires: [{ item: source, count: 2 }], policy: { reserves: [{ item: source, count: 1 }],
        costCaps: expect.arrayContaining([{ item: source, count: 1 }]) } }],
    });
    const nonTimberPlanks = openingAdvice({ kind: "first_policy", reserves: [],
      branches: [{ ...first, then: [timberProgram.branches[0].then[0]] }] });
    expect(bindFirstPlan(request, nonTimberPlanks, visible, { ...liveScope, first: visible })).toEqual({
      reason: "invalid_conditional_program",
    });
  }
});

test("follow-through cannot declare a false trigger, extra stage, invented effect, or lower protected floor", () => {
  const branch = timberProgram.branches[0];
  const [craft, goal] = branch.then;
  for (const then of [
    [], [craft, goal, goal], [{ ...craft, requires: [] }],
    [{ ...craft, requires: [{ item: boundSource, count: 0 }] }],
    [{ ...craft, policy: { ...craft.policy, allowedEffects: ["craft:smelt_iron_ingot"] } }],
    [stockStage("minecraft:iron_ingot", 2, [{ item: "minecraft:raw_iron", count: 2 }],
      ["smelt:minecraft:iron_ingot", "place:minecraft:furnace"], [
        { item: "minecraft:raw_iron", count: 2 }, { item: "minecraft:coal", count: 1 }, { item: "minecraft:furnace", count: 1 },
      ], [], 2, 1)],
    [{ ...craft, policy: { ...craft.policy, allowedEffects: ["break:minecraft:stone"], maxBreaks: 1 } }],
    [{ ...craft, policy: { ...craft.policy, target: { ...craft.policy.target, pos: [0, 64, 0] } } }],
  ]) expect(parseFirstPlanToolArguments(JSON.stringify({ advice: {
    ...timberProgram, branches: [{ ...branch, then }],
  } }))).toBeNull();

  for (const policy of [
    { ...goal.policy, reserves: [{ item: boundPlanks, count: 3 }] },
    { ...goal.policy, reserves: [{ item: boundSource, count: 2 }] },
    { ...goal.policy, maxCrafts: 64 },
  ]) expect(bindFirstPlan(request, openingAdvice({ ...timberProgram, branches: [{ ...branch, then: [craft, { ...goal, policy }] }] }),
    view({ opportunities: [birch] }), liveScope)).toEqual({ reason: "invalid_conditional_program" });
});

test("an ordinary opening does not gather a prefix just to remake retained gear", () => {
  const gather = timberProgram.branches[0];
  const [craft, finish] = gather.then;
  const retained = { ...gather, then: [{ ...craft, policy: { ...craft.policy, reserves: [] } }, finish] };
  const seen = view({ opportunities: [birch], inventory: { "minecraft:wooden_axe": 1 } });
  const scope = { ...liveScope, first: seen };
  const first = { kind: "first_policy", reserves: [], branches: [retained] };
  expect(bindFirstPlan(request, openingAdvice(first), seen, scope)).toEqual({ reason: "opening_target_already_held" });
  expect(bindFirstPlan(request, openingAdvice({ ...first, branches: [retained, plankBranch] }), seen, scope))
    .toMatchObject({ branchIndex: 1 });
  expect(bindFirstPlan({ ...request, objective: "Gather supplies as well as an axe" }, openingAdvice(first), seen, scope))
    .toMatchObject({ branchIndex: 0 });
  expect(bindFirstPlan(request, openingAdvice({ ...first, branches: [gather] }), seen, scope))
    .toMatchObject({ branchIndex: 0 }); // An unfulfilled explicit floor is still work.
});

test("alternatives bind at most one prioritized branch, never weaken a missing prerequisite or borrow its effects", () => {
  const state = view({ inventory: { [reserveLog.item]: 1 }, opportunities: [spruce, recipe] });
  const scope = { ...liveScope, first: state };
  expect(bindFirstPlan(request, { ...alternatives, branches: [stocked] }, state, scope)).toEqual({
    reason: "stock_prerequisite_missing",
  });
  expect(bindFirstPlan(request, { ...alternatives, branches: [{ ...stocked, requires: [] }] }, state, scope)).toEqual({
    reason: "no_matching_live_material",
  });
  expect(bindFirstPlan(request, alternatives, state, scope)).toMatchObject({
    branchIndex: 1, requires: [], policy: {
      target: { kind: "stock", item: "minecraft:spruce_planks", count: 4 },
      reserves: [reserveLog], costCaps: [reserveLog], maxBreaks: 1, maxCrafts: 1,
      allowedEffects: ["break:minecraft:spruce_log", "craft:spruce_planks"],
    },
  });
  const surplus = { ...state, inventory: { [reserveLog.item]: 2 } };
  expect(bindFirstPlan(request, alternatives, surplus, { ...scope, first: surplus })).toMatchObject({
    branchIndex: 0, requires: stocked.requires,
    policy: { reserves: [reserveLog], costCaps: [reserveLog], maxBreaks: 0, allowedEffects: ["craft:spruce_planks"] },
  });
  expect(bindFirstPlan(request, alternatives, surplus, scope, 0)).toEqual({ reason: "stock_prerequisite_missing" });
});

test("the wire can name the exact branch-bound source without guessing a species", () => {
  const first = { ...planks, reserves: [boundReserve], branches: [{ ...plankBranch, requires: [boundReserve] }] };
  expect(parseFirstPlanToolArguments(JSON.stringify({ advice: first }))).toEqual(first);
  expect(parseFirstPlanToolArguments('{"advice":{"kind":"defer","category":"constraint_not_expressible"}}')).toEqual({
    kind: "defer", category: "constraint_not_expressible",
  });
  for (const item of [{ kind: "all_species" }, { kind: "bound_source", species: "spruce" }, "bound_source"]) {
    expect(parseFirstPlanToolArguments(JSON.stringify({ advice: { ...first, reserves: [{ item, count: 1 }] } }))).toBeNull();
  }
});

test("a resolved timber predicate requires actual stock of that timber, with no spending below its resolved floor", () => {
  const first = { ...planks, reserves: [boundReserve], branches: [{ ...plankBranch, requires: [boundReserve],
    policy: { ...plankBranch.policy, source: "witnessed_log", maxBreaks: 0 } }] };
  for (const [input, output] of [
    ["minecraft:spruce_log", "minecraft:spruce_planks"], ["minecraft:birch_log", "minecraft:birch_planks"],
  ] as const) {
    const sample = view({ inventory: { [input]: 2 }, opportunities: [offer("recipe", "continue", "recipe:planks", { [input]: 1 })] });
    expect(bindFirstPlan(request, first, sample, { ...liveScope, first: sample })).toMatchObject({
      input, requires: [{ item: input, count: 1 }], policy: {
        target: { kind: "stock", item: output, count: 4 }, reserves: [{ item: input, count: 1 }],
        costCaps: [{ item: input, count: 1 }], maxBreaks: 0, maxCrafts: 1,
      },
    });
    const noSurplus = { ...sample, inventory: { [input]: 1 } };
    expect(bindFirstPlan(request, first, noSurplus, { ...liveScope, first: noSurplus })).toEqual({ reason: "no_matching_live_material" });
    const later = { ...sample, tick: 6 };
    const emptyAtFirst = { ...sample, inventory: {} };
    expect(bindFirstPlan(request, first, later, { ...liveScope, first: emptyAtFirst })).toEqual({ reason: "stock_prerequisite_missing" });
  }
});

const logAcquisition = { kind: "first_policy", reserves: [boundReserve], branches: [{
  policy: { kind: "harvest_stock", resource: "witnessed_log", count: 1, maxBreaks: 1 }, requires: [],
}] } as const;

test("one real first face starts the exact bounded batch; the total target is not an amount to add", () => {
  const input = "minecraft:birch_log";
  const seen = view({ inventory: { [input]: 1 }, opportunities: [birch] });
  const scope = { ...liveScope, first: seen };
  for (const [count, maxBreaks] of [[3, 4], [2, 1], [4, 1]] as const) {
    const plan = { ...logAcquisition, branches: [{
      policy: { ...logAcquisition.branches[0].policy, count, maxBreaks }, requires: [],
    }] };
    expect(bindFirstPlan(request, plan, seen, scope)).toMatchObject({
      input, liveTargets: [birch.material!.target],
      policy: { target: { kind: "stock", item: input, count }, allowedEffects: [`break:${input}`],
        costCaps: [], reserves: [{ item: input, count: 1 }], maxBreaks, maxCrafts: 0, maxPlacements: 0 },
    });
    expect(bindFirstPlan(request, plan, { ...seen, opportunities: [] }, scope)).toEqual({ reason: "no_matching_live_material" });
    expect(bindFirstPlan(request, plan, { ...seen, opportunities: [
      offer("expensive", "break", `block:${input}`, { "minecraft:wooden_pickaxe": 1 }),
    ] }, scope)).toEqual({ reason: "no_matching_live_material" });
  }
});

test("a pickup alone starts only pickup; mining needs both explicit permission and a real matching zero-spend face", () => {
  const input = "minecraft:birch_log";
  const drop = offer("pickup", "collect", `item:${input}`);
  const seen = view({ inventory: { [input]: 1 }, opportunities: [drop] });
  const scope = { ...liveScope, first: seen };
  const plan = { ...logAcquisition, branches: [{
    policy: { ...logAcquisition.branches[0].policy, resource: input, count: 3, maxBreaks: 4 }, requires: [],
  }] };
  expect(bindFirstPlan(request, plan, seen, scope)).toMatchObject({
    policy: { target: { item: input, count: 3 }, allowedEffects: [], maxBreaks: 0, costCaps: [] },
  });
  const withFace = { ...seen, opportunities: [drop, birch] };
  expect(bindFirstPlan(request, plan, withFace, scope)).toMatchObject({
    policy: { target: { item: input, count: 3 }, allowedEffects: [`break:${input}`], maxBreaks: 4, costCaps: [] },
  });
  expect(bindFirstPlan(request, { ...plan, branches: [{ ...plan.branches[0]!, policy: {
    ...plan.branches[0]!.policy, maxBreaks: 0,
  } }] }, withFace, scope)).toMatchObject({
    policy: { target: { item: input, count: 3 }, allowedEffects: [], maxBreaks: 0, costCaps: [] },
  });
});

test("a first plank ingredient starts a bounded exact batch without granting unseen harvest or spending the reserve", () => {
  const plan = { ...alternatives, branches: [{ ...plankBranch, policy: {
    ...plankBranch.policy, count: 8, maxCrafts: 2, maxBreaks: 2,
  } }] };
  const inventory = { [reserveLog.item]: 2 };
  const seen = view({ inventory, opportunities: [recipe] });
  expect(bindFirstPlan(request, plan, seen, { ...liveScope, first: seen })).toMatchObject({
    policy: { target: { item: "minecraft:spruce_planks", count: 8 }, allowedEffects: ["craft:spruce_planks"],
      maxBreaks: 0, maxCrafts: 2, costCaps: [{ item: reserveLog.item, count: 2 }], reserves: [reserveLog] },
  });
  expect(bindFirstPlan(request, plan, { ...seen, opportunities: [recipe, spruce] }, { ...liveScope, first: seen })).toMatchObject({
    policy: { allowedEffects: ["break:minecraft:spruce_log", "craft:spruce_planks"], maxBreaks: 2, maxCrafts: 2 },
  });
});

test("a witnessed zero-spend acquisition may earn the exact retained floor from empty stock, without granting other effects", () => {
  for (const [input, visible] of [["minecraft:spruce_log", spruce], ["minecraft:birch_log", birch]] as const) {
    expect(bindFirstPlan(request, logAcquisition, view({ opportunities: [visible] }), liveScope)).toMatchObject({
      input, policy: { target: { item: input, count: 1 }, reserves: [{ item: input, count: 1 }],
        allowedEffects: [`break:${input}`], costCaps: [], maxBreaks: 1, maxCrafts: 0, maxPlacements: 0 },
    });
  }
  expect(bindFirstPlan(request, logAcquisition, view({ opportunities: [spruce, birch] }), liveScope)).toEqual({
    reason: "ambiguous_material_binding",
  });
  const exactAfterAmbiguity = { ...logAcquisition, branches: [
    logAcquisition.branches[0],
    { ...logAcquisition.branches[0], policy: { ...logAcquisition.branches[0].policy, resource: reserveLog.item } },
  ] };
  expect(bindFirstPlan(request, exactAfterAmbiguity, view({ opportunities: [spruce, birch] }), liveScope)).toEqual({
    reason: "ambiguous_material_binding",
  });
  expect(bindFirstPlan(request, logAcquisition, view({
    inventory: { [reserveLog.item]: 1 }, opportunities: [birch],
  }), liveScope)).toMatchObject({
    input: "minecraft:birch_log", policy: { reserves: [{ item: "minecraft:birch_log", count: 1 }], costCaps: [] },
  });
  const stripped = offer("stripped", "break", "block:minecraft:stripped_birch_log");
  expect(bindFirstPlan(request, logAcquisition, view({ opportunities: [stripped] }), liveScope)).toEqual({
    reason: "no_matching_live_material",
  });
  const two = { ...logAcquisition, reserves: [{ ...boundReserve, count: 2 }], branches: [{
    policy: { ...logAcquisition.branches[0].policy, count: 4, maxBreaks: 4 }, requires: [],
  }] };
  expect(bindFirstPlan(request, two, view({ opportunities: [spruce] }), liveScope)).toEqual({ reason: "protected_stock_missing" });
  const secondFace = offer("second-face", "break", "block:minecraft:spruce_log");
  expect(bindFirstPlan(request, two, view({ opportunities: [spruce, secondFace] }), liveScope)).toMatchObject({
    policy: { target: { item: "minecraft:spruce_log", count: 4 }, reserves: [{ item: "minecraft:spruce_log", count: 2 }],
      maxBreaks: 4, costCaps: [] },
  });
  expect(bindFirstPlan(request, { ...logAcquisition, reserves: [boundReserve, reserveLog] },
    view({ opportunities: [birch] }), liveScope)).toEqual({ reason: "protected_stock_missing" });
  expect(bindFirstPlan(request, { ...planks, reserves: [boundReserve] }, view({ opportunities: [spruce] }), liveScope)).toEqual({
    reason: "protected_stock_missing",
  });
});

test("a non-timber bound floor names the inventory output, not the observed block", () => {
  const coal = { kind: "first_policy", branches: [{
    policy: { kind: "harvest_stock", resource: "minecraft:coal", count: 1, maxBreaks: 1 }, requires: [],
  }], reserves: [boundReserve] } as const;
  expect(bindFirstPlan(request, coal, view({ opportunities: [offer("ore", "break", "block:minecraft:deepslate_coal_ore")] }),
    liveScope)).toMatchObject({
    input: "minecraft:coal",
    policy: { target: { item: "minecraft:coal", count: 1 }, reserves: [{ item: "minecraft:coal", count: 1 }],
      allowedEffects: ["break:minecraft:deepslate_coal_ore"], costCaps: [] },
  });
});

test("a goal-only result cannot migrate to another goal, life, or safety revision", () => {
  const live = view({ opportunities: [spruce] });
  for (const sample of [
    { ...live, run: "other" },
    { ...live, goal: "diamond" },
    { ...live, life: 2, epoch: 2, tick: 8 },
    { ...live, health: 0 },
    { ...live, health: 19 },
    { ...live, safety: { clear: false, revision: 2 } },
  ]) expect(bindFirstPlan(request, planks, sample, liveScope)).toEqual({ reason: "live_scope_changed" });
});

const result = (proposal: FirstPlanInference["proposal"], outcome: FirstPlanInference["outcome"] = "completed") =>
  ({ stage: PRE_SPAWN_GOAL_ONLY, model: TERRA_MODEL_ID, outcome, proposal, dispatched: true,
    latencyMs: 2, providerStartedAtMs: performance.now(), usage: null, costUsd: null }) satisfies FirstPlanInference;

async function fixture(infer: FirstPlanStrategist, signal?: AbortSignal, maxRequests = 1, strategy: "terra" | "deterministic" = "terra",
  opening: FirstPlanRequest = { ...request, objective: "Mine a stone pickaxe" }) {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-first-plan-"));
  const run = path.basename(dir);
  let liveCalls = 0;
  const controller = new SurvivalMacroController({ runDir: dir, run, strategy, signal,
    ...(strategy === "terra" ? { durableWork: true, objective: opening.objective } : {}),
    limits: { maxRequests, pollMs: 1000 }, confirmNativeExit: async () => true,
    firstPlan: { request: opening, infer },
    strategist: async ({ observation: { run, life, epoch, tick } }) => {
      liveCalls++;
      return { basis: { run, life, epoch, tick }, outcome: "refused", model: TERRA_MODEL_ID,
        proposal: null, usage: null, costUsd: null, dispatched: true };
    },
  });
  const file = (name: string) => path.join(controller.directory, name);
  async function observe(change: Partial<MacroObservation> = {}) {
    await writeFile(file("observation.pending"), JSON.stringify(view({ ...change, run })), { mode: 0o600 });
    await rename(file("observation.pending"), file("observation.json"));
    await controller.poll();
  }
  async function log(name: string) {
    return (await readFile(file(name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  async function receipt(id: string, tick: number, status: MacroReceipt["status"]) {
    await appendFile(file("native-receipts.jsonl"), `${JSON.stringify({
      v: 1, run, life: 1, id, tick, status, detail: status,
    })}\n`, { mode: 0o600 });
  }
  const order = async () => parseMacroWorkOrder(JSON.parse(await readFile(file("work.json"), "utf8")));
  await controller.start();
  return { controller, observe, log, file, order, receipt, liveCalls: () => liveCalls, close: async () => {
    try { await controller.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  } };
}

test("one paid startup request uses the existing quota and publishes only after a real matching view", async () => {
  const sent = Promise.withResolvers<FirstPlanRequest>();
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async input => { sent.resolve(input); return reply.promise; });
  try {
    expect(await sent.promise).toEqual({ goal: GOAL, objective: "Mine a stone pickaxe" });
    for (const name of ["observation.json", "planning.json", "intent.json", "work.json"])
      await expect(access(f.file(name))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 0, issuedWorkOrders: 0 });
    reply.resolve(result(planks));
    await f.observe({ opportunities: [spruce] });
    expect(JSON.parse(await readFile(f.file("work.json"), "utf8"))).toMatchObject({
      origin: "model", life: 1, epoch: 1, basisTick: 5,
      target: { kind: "stock", item: "minecraft:spruce_planks", count: 4 },
    });
    await f.observe({ tick: 6, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(0);
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, budget: "requests",
      issuedWorkOrders: 1, completedModelWorkOrders: 0 });
    expect(await f.log("proposals.jsonl")).toMatchObject([{ stage: PRE_SPAWN_GOAL_ONLY, basis: null, dispatched: true }]);
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_bound")).toMatchObject({
      stage: PRE_SPAWN_GOAL_ONLY, basis: { tick: 5 }, timeToFirstUseMs: expect.any(Number),
    });
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

test("the ordinary held-log opening publishes only stage 2 and credits just its native accepted and completed receipts", async () => {
  const f = await fixture(async () => result(heldTimberAdvice), undefined, 2, "terra", pickRequest);
  try {
    const source = "minecraft:oak_log";
    // The first sample has real inventory but no rendered offers yet.
    const live = heldTimber(source);
    await f.observe({ ...live, opportunities: [] });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    await f.observe({ ...live, tick: 10 });
    const [proposal] = await f.log("proposals.jsonl");
    const work = await f.order();
    expect(work).toMatchObject({ id: `${proposal.requestId}:2`, origin: "model", target: { item: pick, count: 1 },
      maxBreaks: 0, maxCrafts: 6, maxPlacements: 1 });
    expect(work.nextWorkId).toBeUndefined();
    expect(f.controller.status()).toMatchObject({ issuedWorkOrders: 1, completedModelWorkOrders: 0, completedWorkPrograms: 0 });
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({
      event: "first_plan_bound", requestId: proposal.requestId, firstIssuedStage: 2, declaredStages: 2,
      stockSatisfied: [{ stage: 1, item: source, required: 3, observed: 3 }], nativeAccepted: false,
    }));
    await f.receipt(work.id, 11, "accepted");
    await f.observe({ ...live, tick: 11, workOrder: { id: work.id, state: "working", detail: "Working" } });
    expect(f.controller.status().completedWorkProgram).toBeNull();
    await f.receipt(work.id, 30, "completed");
    await f.controller.poll();
    expect(f.controller.status().completedWorkProgram).toBeNull(); // The receipt alone isn't stock evidence.
    await f.observe({ ...live, tick: 30, epoch: 2, opportunities: [], inventory: { [pick]: 1 },
      workOrder: { id: work.id, state: "complete", detail: "Wooden pickaxe confirmed" } });
    expect(await f.log("receipts.jsonl")).toMatchObject(["accepted", "completed"].map(status => ({
      requestId: proposal.requestId, programStage: 2, eligible: true, receipt: { id: work.id, status },
    })));
    expect(f.controller.status()).toMatchObject({ requests: 1, issuedWorkOrders: 1, completedModelWorkOrders: 1,
      completedWorkPrograms: 1, completedWorkProgram: { requestId: proposal.requestId, stages: 1, declaredStages: 2,
        executedStages: [2], invocationItemCount: 1, receipt: { id: work.id, status: "completed" } } });
    expect(f.liveCalls()).toBe(0);
  } finally { await f.close(); }
});

test.each([
  ["changed epoch", { tick: 6, epoch: 2 }, "fresh_binding_changed"],
  ["gone grid", { tick: 6, opportunities: [footing] }, "no_matching_live_material"],
  ["lost stock", { tick: 6, inventory: {} }, "no_matching_live_material"],
  ["unsafe", { tick: 6, safety: { clear: false, revision: 2 } }, "live_scope_changed"],
  ["late", { tick: 16 }, "first_actionable_view_deadline"],
] as const)("held timber is not authority to issue the suffix after %s", async (_name, change, reason) => {
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async () => reply.promise, undefined, 1, "terra", { ...pickRequest, objective: "Make a wooden pickaxe" });
  try {
    const live = heldTimber("minecraft:oak_log");
    await f.observe(live);
    reply.resolve(result(heldTimberAdvice));
    await f.observe({ ...live, ...change });
    expect(f.controller.status()).toMatchObject({ issuedWorkOrders: 0, completedModelWorkOrders: 0, completedWorkPrograms: 0 });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({ event: "first_plan_rejected", reason }));
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

test("canceled held-stock handoff neither publishes nor creates model receipt credit", async () => {
  const abort = new AbortController();
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async () => reply.promise, abort.signal, 1, "terra", pickRequest);
  try {
    await f.observe(heldTimber("minecraft:oak_log"));
    abort.abort();
    reply.resolve(result(heldTimberAdvice));
    await f.controller.stop();
    expect(f.controller.status()).toMatchObject({ requests: 1, issuedWorkOrders: 0, completedModelWorkOrders: 0,
      completedWorkPrograms: 0, completedWorkProgram: null });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({ event: "first_plan_rejected", reason: "stop" }));
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

test("a fully satisfied held-stock chain has no model order, receipt or completed program", async () => {
  const f = await fixture(async () => result(heldTimberAdvice), undefined, 1, "terra", { ...pickRequest, objective: "Make a wooden pickaxe" });
  try {
    const source = "minecraft:oak_log";
    await f.observe({ ...heldTimber(source), inventory: { [source]: 3, [pick]: 1 } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({ requests: 1, issuedWorkOrders: 0, completedModelWorkOrders: 0,
      completedWorkPrograms: 0, completedWorkProgram: null });
    expect(await f.log("receipts.jsonl")).toEqual([]);
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({
      event: "first_plan_rejected", reason: "opening_target_already_held",
    }));
  } finally { await f.close(); }
});

test("one paid opening completes three ordinary jobs with exact native receipts and an adjacent personal GUI handoff", async () => {
  const cobble = { item: "minecraft:cobblestone", count: 3 };
  const held = { [cobble.item]: cobble.count };
  const [gather] = timberProgram.branches;
  const finish = stockStage(`minecraft:${GOAL}`, 1, [{ item: boundPlanks, count: 10 }, cobble],
    [`craft:${GOAL}`, "craft:stick", "craft:crafting_table", "place:minecraft:crafting_table"],
    [cobble, { item: "minecraft:stick", count: 2 }, { item: boundPlanks, count: 6 }, { item: "minecraft:crafting_table", count: 1 }],
    [], 3, 1);
  const advice = openingAdvice({ ...timberProgram, branches: [
    { ...gather, policy: { ...gather.policy, resource: "minecraft:acacia_log" }, requires: [cobble], then: [gather.then[0], finish] },
    { ...gather, requires: [cobble], then: [gather.then[0], finish] },
  ] });
  const f = await fixture(async () => result(advice), undefined, 2);
  try {
    await expect(access(f.file("work.json"))).rejects.toThrow();
    await f.observe({ inventory: held, opportunities: [birch] });
    const first = await f.order();
    const log = "minecraft:birch_log", plank = "minecraft:birch_planks";
    expect(first).toMatchObject({ target: { item: log, count: 4 }, allowedEffects: [`break:${log}`] });
    await f.receipt(first.id, 6, "accepted");
    await f.observe({ tick: 39, inventory: { ...held, [log]: 3 }, workOrder: {
      id: first.id, state: "needs_replan", detail: "Gather active",
      progress: { phase: "harvest", status: "Breaking", breaks: 3, crafts: 0, placements: 0,
        lastEffect: { tick: 38, detail: "Collected a log" }, replan: "target_near" },
    } });
    expect(f.liveCalls()).toBe(0); // The authorized successor already answers this early replan signal.
    await f.receipt(first.id, 40, "completed");
    await f.controller.poll(); // The journal alone never makes projected stock live.
    await expect(access(f.file("work.json"))).rejects.toThrow();
    await f.observe({ tick: 40, epoch: 2, inventory: { ...held, [log]: 4 }, workOrder: {
      id: first.id, state: "complete", detail: "Confirmed logs",
    } });
    const second = await f.order();
    expect(second).toMatchObject({ id: first.nextWorkId!, expiresTick: first.expiresTick,
      target: { item: plank, count: 12 }, allowedEffects: ["craft:birch_planks"] });
    await f.receipt(second.id, 41, "accepted");
    await f.receipt(second.id, 60, "completed");
    await f.observe({ tick: 60, epoch: 3, inventory: { ...held, [log]: 1, [plank]: 12 }, quiescent: false, workOrder: {
      id: second.id, state: "complete", detail: "Confirmed personal inventory craft",
    } });
    const third = await f.order();
    expect(third).toMatchObject({ id: second.nextWorkId!, expiresTick: first.expiresTick,
      target: { item: `minecraft:${GOAL}`, count: 1 },
      reserves: [{ item: log, count: 1 }, { item: plank, count: 4 }],
    });
    expect(third.nextWorkId).toBeUndefined();
    await f.receipt(third.id, 61, "accepted");
    await f.receipt(third.id, 80, "completed");
    await f.observe({ tick: 80, epoch: 4,
      inventory: { [log]: 1, [plank]: 6, "minecraft:stick": 2, [`minecraft:${GOAL}`]: 1 },
      workOrder: { id: third.id, state: "complete", detail: "Confirmed invocation item and stock" } });
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1,
      issuedWorkOrders: 3, completedModelWorkOrders: 3, completedWorkPrograms: 1, workQueuedAfter: null,
      completedWorkProgram: { stage: PRE_SPAWN_GOAL_ONLY, branchIndex: 1, stages: 3, invocationItemCount: 1,
        receipt: { id: third.id, status: "completed" }, basis: { tick: 80 } },
    });
    expect(f.liveCalls()).toBe(0); // Spare quota is not spent just to announce an already verified result.
    const receipts = await f.log("receipts.jsonl");
    const [proposal] = await f.log("proposals.jsonl");
    expect(receipts).toHaveLength(6);
    for (const row of receipts) expect(row).toMatchObject({ stage: PRE_SPAWN_GOAL_ONLY, requestId: proposal.requestId, eligible: true });
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_bound")).toMatchObject({
      branchIndex: 1, declaredStages: 3, eligiblePrefixStages: 3,
    });
  } finally { await f.close(); }
});

test("an arithmetically impossible suffix cannot claim completion or grant an adjacent ID", async () => {
  const branch = timberProgram.branches[0];
  const [craft, finish] = branch.then;
  const advice = openingAdvice({ ...timberProgram, branches: [{ ...branch, then: [craft,
    { ...finish, requires: [{ item: boundPlanks, count: 13 }] },
  ] }] });
  const f = await fixture(async () => result(advice));
  try {
    await f.observe({ opportunities: [birch] });
    const first = await f.order();
    const log = "minecraft:birch_log", plank = "minecraft:birch_planks";
    await f.receipt(first.id, 6, "accepted");
    await f.receipt(first.id, 20, "completed");
    await f.observe({ tick: 20, epoch: 2, inventory: { [log]: 4 } });
    const second = await f.order();
    expect(second.id).toBe(first.nextWorkId!);
    expect(second.nextWorkId).toBeUndefined();
    await f.receipt(second.id, 21, "accepted");
    await f.receipt(second.id, 40, "completed");
    await f.observe({ tick: 40, epoch: 3, inventory: { [log]: 1, [plank]: 12 } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({
      requests: 1, issuedWorkOrders: 2, completedModelWorkOrders: 2, completedWorkPrograms: 0, completedWorkProgram: null,
    });
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({
      event: "work_successor_discarded", stage: 3, reason: "work_resource_shortage", programSource: PRE_SPAWN_GOAL_ONLY,
    }));
  } finally { await f.close(); }
});

test("an unaffordable new workstation and no offered alternative leave the third stage to live planning", async () => {
  const f = await fixture(async () => result(openingAdvice(timberProgram)), undefined, 2);
  try {
    await f.observe({ opportunities: [birch] });
    const first = await f.order();
    const log = "minecraft:birch_log", plank = "minecraft:birch_planks";
    await f.receipt(first.id, 6, "accepted");
    await f.receipt(first.id, 20, "completed");
    await f.observe({ tick: 20, epoch: 2, inventory: { [log]: 4 } });
    const second = await f.order();
    expect(second.nextWorkId).toBeDefined(); // A live table could still make the proposed route feasible.
    await f.receipt(second.id, 21, "accepted");
    await f.receipt(second.id, 40, "completed");
    await f.observe({ tick: 40, epoch: 3, inventory: { [log]: 1, [plank]: 12 }, quiescent: false, workOrder: {
      id: second.id, state: "complete", detail: "Confirmed personal inventory craft",
    } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({ requests: 2, issuedWorkOrders: 2, completedWorkPrograms: 0 });
    expect(f.liveCalls()).toBe(1);
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({
      event: "work_successor_discarded", stage: 3, afterWorkId: second.id, reason: "opening_start_not_confirmed",
    }));
  } finally { await f.close(); }
});

test.each([
  ["interrupted", 4, { quiescent: true }, "predecessor_did_not_complete"],
  ["completed", 3, { quiescent: true }, "predecessor_stock_not_confirmed"],
  ["completed", 4, { quiescent: false }, "opening_handoff_not_confirmed"],
  ["completed", 4, { safety: { clear: false, revision: 2 } }, "scope_or_ttl_changed"],
  ["completed", 4, { life: 2 }, "scope_or_ttl_changed"],
] as const)("a %s receipt, %d live logs and %j admit no conditional successor", async (status, logs, change, reason) => {
  const f = await fixture(async () => result(openingAdvice(timberProgram)));
  try {
    await f.observe({ opportunities: [spruce] });
    const first = await f.order();
    await f.receipt(first.id, 6, "accepted");
    await f.receipt(first.id, 20, status);
    await f.observe({ ...change, tick: 20, epoch: 2, inventory: { "minecraft:spruce_log": logs } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({ requests: 1, issuedWorkOrders: 1, completedWorkPrograms: 0 });
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({
      event: "work_successor_discarded", stage: 2, reason, programSource: PRE_SPAWN_GOAL_ONLY,
    }));
  } finally { await f.close(); }
});

test("Stop revokes a conditional successor while the latest native view is still behind its receipt", async () => {
  const f = await fixture(async () => result(openingAdvice(timberProgram)));
  try {
    await f.observe({ opportunities: [birch] });
    const first = await f.order();
    await f.receipt(first.id, 6, "accepted");
    await f.receipt(first.id, 20, "completed");
    await f.controller.poll();
    expect(f.controller.status().workQueuedAfter).toBe(first.id);
    await f.controller.stop();
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({ requests: 1, issuedWorkOrders: 1, workQueuedAfter: null,
      completedWorkPrograms: 0 });
    expect(await f.log("history.jsonl")).toContainEqual(expect.objectContaining({
      event: "work_successor_discarded", stage: 2, reason: "scope_or_ttl_changed", programSource: PRE_SPAWN_GOAL_ONLY,
    }));
  } finally { await f.close(); }
});

test("a camera warm-up is inert and can bind a shared-reserve fallback only on the first actionable live view", async () => {
  const f = await fixture(async () => result(alternatives));
  try {
    const inventory = { [reserveLog.item]: 1 };
    await f.observe({ inventory });
    for (const name of ["planning.json", "intent.json", "work.json"])
      await expect(access(f.file(name))).rejects.toThrow();
    expect(f.liveCalls()).toBe(0);
    await f.observe({ tick: 10, inventory, opportunities: [spruce, recipe] });
    const order = JSON.parse(await readFile(f.file("work.json"), "utf8"));
    expect(order).toMatchObject({ basisTick: 10, maxBreaks: 1, maxCrafts: 1, reserves: [reserveLog] });
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, completedModelWorkOrders: 0 });
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_bound")).toMatchObject({
      branchIndex: 1, firstBasis: { tick: 5 }, actionableBasis: { tick: 10 }, basis: { tick: 10 }, nativeAccepted: false,
    });
    await writeFile(f.file("native-receipts.jsonl"), ["accepted", "completed"].map((status, index) =>
      JSON.stringify({ v: 1, run: order.run, life: 1, id: order.id, tick: 11 + index, status, detail: status })).join("\n") + "\n",
      { mode: 0o600 });
    await f.observe({ tick: 12, inventory: { ...inventory, "minecraft:spruce_planks": 4 } });
    expect(f.controller.status()).toMatchObject({ completedModelWorkOrders: 1, providerDispatches: 1 });
    expect(await f.log("receipts.jsonl")).toMatchObject([
      { stage: PRE_SPAWN_GOAL_ONLY, eligible: true, receipt: { id: order.id, status: "accepted" } },
      { stage: PRE_SPAWN_GOAL_ONLY, eligible: true, receipt: { id: order.id, status: "completed" } },
    ]);
  } finally { await f.close(); }
});

test("a too-late view cannot revive a paid advisory after its first-view window elapsed", async () => {
  const f = await fixture(async () => result(planks), undefined, 2);
  try {
    await f.observe();
    await f.observe({ tick: 16, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(1);
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      firstBasis: { tick: 5 }, basis: { tick: 16 }, reason: "first_actionable_view_deadline",
    });
  } finally { await f.close(); }
});

test("known-false stock predicates do not keep the opening waiting for the camera", async () => {
  const f = await fixture(async () => result({ ...alternatives, branches: [stocked] }), undefined, 2);
  try {
    await f.observe({ inventory: { [reserveLog.item]: 1 } });
    expect(f.liveCalls()).toBe(1);
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      firstBasis: { tick: 5 }, reason: "stock_prerequisite_missing",
    });
  } finally { await f.close(); }
});

test("the published native order contains only exact IDs with the bound floor intact when starting below it", async () => {
  const f = await fixture(async () => result(logAcquisition));
  try {
    await f.observe({ opportunities: [birch] });
    const order = JSON.parse(await readFile(f.file("work.json"), "utf8"));
    expect(order).toMatchObject({
      target: { kind: "stock", item: "minecraft:birch_log", count: 1 },
      reserves: [{ item: "minecraft:birch_log", count: 1 }],
      allowedEffects: ["break:minecraft:birch_log"], costCaps: [],
      maxBreaks: 1, maxCrafts: 0, maxPlacements: 0,
    });
    expect(JSON.stringify(order)).not.toContain("bound_source");
    expect(f.controller.status()).toMatchObject({ requests: 1, completedModelWorkOrders: 0 });
  } finally { await f.close(); }
});

test("Stop while loading joins the startup call and records the charge even though no game observation existed", async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const f = await fixture(async (_input, signal, onDispatch) => {
    onDispatch(performance.now());
    started.resolve();
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return result(null, "cancelled");
  }, abort.signal);
  try {
    await started.promise;
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, unreportedDispatches: 1 });
    abort.abort();
    await f.controller.stop();
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, unreportedDispatches: 0,
      issuedWorkOrders: 0 });
    expect(await f.log("proposals.jsonl")).toMatchObject([{
      stage: PRE_SPAWN_GOAL_ONLY, basis: null, providerOutcome: "cancelled", dispatched: true,
    }]);
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      stage: PRE_SPAWN_GOAL_ONLY, reason: "stop", basis: null,
    });
    await expect(access(f.file("work.json"))).rejects.toThrow();
  } finally {
    abort.abort();
    await f.close();
  }
});

test("no late startup authority is admitted after respawn; the ordinary strategist waits for settlement", async () => {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async () => { started.resolve(); return reply.promise; }, undefined, 2);
  try {
    await started.promise;
    await f.observe({ opportunities: [spruce] });
    expect(f.liveCalls()).toBe(0);
    await f.observe({ tick: 6, life: 2, epoch: 2, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(0);
    reply.resolve(result(planks));
    await f.observe({ tick: 7, life: 2, epoch: 2, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(1);
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      reason: "live_scope_changed", basis: { life: 2 },
    });
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

for (const [change, reason, opportunities] of [
  ["the first face disappeared", "no_matching_live_material", []],
  ["a different species replaced the first face", "fresh_binding_changed", [birch]],
] as const) {
  test(`a settled plan cannot publish stale work when ${change}`, async () => {
    const reply = Promise.withResolvers<FirstPlanInference>();
    const f = await fixture(async () => reply.promise, undefined, 2);
    try {
      await f.observe({ opportunities: [spruce] });
      reply.resolve(result(planks));
      await f.observe({ tick: 6, opportunities });
      await expect(access(f.file("work.json"))).rejects.toThrow();
      expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
        reason, basis: { tick: 6 }, firstBasis: { tick: 5 },
      });
    } finally {
      reply.resolve(result(null, "cancelled"));
      await f.close();
    }
  });
}

test("deterministic and prepared diagnostic never admit a paid first plan", async () => {
  let called = false;
  const f = await fixture(async () => { called = true; return result(planks); }, undefined, 1, "deterministic");
  try {
    const diagnostic = declareTerraStrategy({ maxRequests: 1, startup: "allow" }, 1_000, { preparedDiagnostic: true });
    expect(diagnostic.startup).toBe("off");
    expect(() => composeTerraSurvival({ declaration: diagnostic, firstPlanGoal: GOAL, projectRoot: "/example",
      dir: "/example/local/survival-agent/diagnostic-runs/test", actorJarSha256: "unused",
      display: { display: "unused", authority: "unused", stillOwned: () => false },
      width: 1, height: 1, ffmpeg: "unused", signal: new AbortController().signal,
      authDirectory: "unused", onDisplayLoss: () => {}, confirmNativeExit: async () => true,
    })).toThrow("did not admit goal-only startup inference");
    expect(declareTerraStrategy({ maxRequests: 1, startup: "off" }, 1_000).startup).toBe("off");
    expect(declareTerraStrategy({ maxRequests: 1 }, 1_000).startup).toBe("allow");
    expect(f.controller.status().requests).toBe(0);
    expect(called).toBe(false);
  } finally { await f.close(); }
});

test("provider time before observed play is tagged separately and does not count as native work or pause", () => {
  const note = reviewPauseJournal(
    "v1\trun\nstate\t1000000000\t1\tidle\nstate\t1200000000\t2\troute\ninput\t1200000000\t2\nend\t1400000000\t3\tgoal_completed\n",
    { run: "run", runStartedNs: 0n, cutoffNs: 1_400_000_000n,
      providerSpans: [{ startNs: 500_000_000n, endNs: 1_100_000_000n, terminalObserved: true, stage: PRE_SPAWN_GOAL_ONLY }] },
  );
  expect(note).toMatchObject({
    startupProviderPendingBeforeGameplayMs: 500,
    allGameplay: { longestIdleMs: 200 },
    providerOverlap: { pendingGameplayMs: 100, usefulOverlapMs: 0 },
    providerSpans: [{ stage: PRE_SPAWN_GOAL_ONLY, startMs: -500, endMs: 100 }],
  });
});
