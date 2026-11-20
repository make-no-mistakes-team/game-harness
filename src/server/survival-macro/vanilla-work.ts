import {
  MACRO_FURNACE_PLACEMENT, MACRO_IRON_FUEL_TICKS, MACRO_IRON_SMELT,
  type MacroObservation, type MacroStockFloor, type MacroWorkPolicy, type MacroWorkStage,
} from "./protocol.ts";

const vanilla = (name: string) => `minecraft:${name}`;
const TABLE = vanilla("crafting_table");
const STICK = vanilla("stick");
const FURNACE = vanilla("furnace");
const RAW_IRON = vanilla("raw_iron");
const IRON_INGOT = vanilla("iron_ingot");
const IRON_COOK_TICKS = 200;

// Public vanilla 1.21.4 facts, shared with opening binding. These say nothing about the player's world.
export const VANILLA_TIMBER_RECIPES: ReadonlyMap<string, string> = new Map(
  ([
    ["oak", ["log", "wood"]], ["spruce", ["log", "wood"]], ["birch", ["log", "wood"]],
    ["jungle", ["log", "wood"]], ["acacia", ["log", "wood"]], ["dark_oak", ["log", "wood"]],
    ["mangrove", ["log", "wood"]], ["cherry", ["log", "wood"]], ["pale_oak", ["log", "wood"]],
    ["crimson", ["stem", "hyphae"]], ["warped", ["stem", "hyphae"]], ["bamboo", ["block"]],
  ] as const).flatMap(([species, forms]) =>
    forms.flatMap(form => ["", "stripped_"].map(prefix => [vanilla(`${prefix}${species}_${form}`), `${species}_planks`] as const))),
);
export const VANILLA_HARVEST_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  [vanilla("cobblestone"), ["stone", "cobblestone"].map(vanilla)],
  [vanilla("coal"), ["coal_ore", "deepslate_coal_ore"].map(vanilla)],
]);

interface Ingredient {
  readonly items: readonly string[];
  readonly count: number;
}
interface Recipe {
  readonly batch: number;
  readonly ingredients: readonly Ingredient[];
  readonly bench: boolean;
}

const recipe = (batch: number, bench: boolean, ...ingredients: readonly Ingredient[]): Recipe => ({ batch, bench, ingredients });
const group = (items: readonly string[], count: number): Ingredient => ({ items, count });
const exact = (item: string, count: number) => group([vanilla(item)], count);
const timberByRecipe = new Map<string, string[]>();
for (const [item, key] of VANILLA_TIMBER_RECIPES) {
  const inputs = timberByRecipe.get(key);
  if (inputs) inputs.push(item);
  else timberByRecipe.set(key, [item]);
}
const plankKeys = [...timberByRecipe.keys()];
const planks = plankKeys.map(vanilla);
const stone = ["cobblestone", "cobbled_deepslate", "blackstone"].map(vanilla);
const wooden = (count: number) => group(planks, count);
const rocky = (count: number) => group(stone, count);
const sticks = (count: number) => group([STICK], count);
const iron = (count: number) => exact("iron_ingot", count);
// Ingredient groups match the native actor's AgentHands recipe grid. A group permits mixed
// ingredients per cell unless the recipe names an exact item (e.g. a boat's one plank species).
const RECIPES = new Map<string, Recipe>([
  ...[...timberByRecipe].map(([key, items]) => [key, recipe(key === "bamboo_planks" ? 2 : 4, false, group(items, 1))] as const),
  ...plankKeys.filter(key => key !== "crimson_planks" && key !== "warped_planks").map(key =>
    [key === "bamboo_planks" ? "bamboo_raft" : key.replace(/_planks$/, "_boat"), recipe(1, true, exact(key, 5))] as const),
  ["stick", recipe(4, false, wooden(2))],
  ["crafting_table", recipe(1, false, wooden(4))],
  ["wooden_pickaxe", recipe(1, true, wooden(3), sticks(2))],
  ["wooden_shovel", recipe(1, true, wooden(1), sticks(2))],
  ["wooden_axe", recipe(1, true, wooden(3), sticks(2))],
  ["stone_pickaxe", recipe(1, true, rocky(3), sticks(2))],
  ["stone_shovel", recipe(1, true, rocky(1), sticks(2))],
  ["stone_axe", recipe(1, true, rocky(3), sticks(2))],
  ["stone_sword", recipe(1, true, rocky(2), sticks(1))],
  ["furnace", recipe(1, true, rocky(8))],
  ["iron_pickaxe", recipe(1, true, iron(3), sticks(2))],
  ["iron_shovel", recipe(1, true, iron(1), sticks(2))],
  ["diamond_pickaxe", recipe(1, true, exact("diamond", 3), sticks(2))],
  ["bucket", recipe(1, true, iron(3))],
  ["flint_and_steel", recipe(1, false, iron(1), exact("flint", 1))],
  ["shield", recipe(1, true, wooden(6), iron(1))],
  ["iron_chestplate", recipe(1, true, iron(8))],
  ["iron_leggings", recipe(1, true, iron(7))],
  ["iron_helmet", recipe(1, true, iron(5))],
  ["iron_boots", recipe(1, true, iron(4))],
  ["torch", recipe(4, false, group([vanilla("coal"), vanilla("charcoal")], 1), sticks(1))],
]);
export const VANILLA_WORK_RECIPE_KEYS: readonly string[] = Object.freeze([...RECIPES.keys()]);

// Maximum counted material per authorized break, not a promise of a drop or a suitable tool.
const HARVEST = new Map<string, { item: string; yield: number }>();
function harvest(item: string, blocks: readonly string[], maxYield: number) {
  for (const block of blocks) HARVEST.set(block, { item, yield: maxYield });
}
for (const [item, blocks] of VANILLA_HARVEST_SOURCES) harvest(item, blocks, item === vanilla("coal") ? 4 : 1);
for (const item of [...VANILLA_TIMBER_RECIPES.keys(), ...["sand", "red_sand", "tuff", "granite", "diorite", "andesite"].map(vanilla)])
  harvest(item, [item], 1);
harvest(vanilla("bamboo"), [vanilla("bamboo")], 64); // Breaking a stalk can drop its upper segments.
harvest(vanilla("cobbled_deepslate"), ["deepslate", "cobbled_deepslate"].map(vanilla), 1);
harvest(vanilla("dirt"), ["dirt", "grass_block"].map(vanilla), 1);
harvest(vanilla("clay_ball"), [vanilla("clay")], 4);
for (const [ore, item, max] of [
  ["iron", "raw_iron", 4], ["copper", "raw_copper", 20], ["gold", "raw_gold", 4], ["diamond", "diamond", 4],
  ["redstone", "redstone", 8], ["lapis", "lapis_lazuli", 36], ["emerald", "emerald", 4],
] as const) harvest(vanilla(item), [`${ore}_ore`, `deepslate_${ore}_ore`].map(vanilla), max);
harvest(vanilla("quartz"), [vanilla("nether_quartz_ore")], 4);

export interface VanillaWorkDiagnostic {
  readonly stageIndex: number;
  readonly detail: string;
}
export type VanillaWorkPreflight =
  | { readonly kind: "possible" }
  | { readonly kind: "unknown"; readonly stageIndex?: never; readonly detail?: never }
  | ({ readonly kind: "unknown" } & VanillaWorkDiagnostic)
  | ({ readonly kind: "shortage" } & VanillaWorkDiagnostic);

type Stock = Map<string, number>;
const get = (stock: ReadonlyMap<string, number>, item: string) => stock.get(item) ?? 0;
const change = (stock: Stock, item: string, amount: number) => stock.set(item, get(stock, item) + amount);
function floorAtLeast(floors: Stock, { item, count }: MacroStockFloor) {
  floors.set(item, Math.max(get(floors, item), count));
}

interface Path {
  readonly stock: Stock;
  readonly pickups: Stock;
  readonly reserves: Stock;
  readonly existingTable: boolean;
  readonly existingFurnace: boolean;
  placedTable: boolean;
  firstBench?: number;
  firstFurnace?: number;
  /** Acquisition is conditional; choice means a different material allocation may change the answer. */
  prospective: boolean;
  choice: boolean;
}

class StageArithmetic {
  private readonly start: Stock;
  private readonly caps: Stock;
  private readonly spent: Stock = new Map();
  private readonly harvests: Stock = new Map();
  private readonly allowed: ReadonlySet<string>;
  private readonly unknownBreak: boolean;
  private readonly unknownRecipe: boolean;
  private breaks = 0;
  private crafts = 0;
  private placements = 0;
  problem?: string;
  uncertain = false;

  constructor(private readonly path: Path, private readonly policy: MacroWorkPolicy, private readonly index: number) {
    this.start = new Map(path.stock);
    this.caps = new Map(policy.costCaps.map(({ item, count }) => [item, count]));
    this.allowed = new Set(policy.allowedEffects);
    let unknownBreak = false, unknownRecipe = false;
    for (const effect of this.allowed) {
      if (effect.startsWith("break:") && policy.maxBreaks > 0) {
        const source = HARVEST.get(effect.slice(6));
        if (source) this.harvests.set(source.item, Math.max(get(this.harvests, source.item), source.yield));
        else unknownBreak = true;
      } else if (effect.startsWith("craft:") && policy.maxCrafts > 0) {
        const key = effect.slice(6);
        if (key !== "planks" && !RECIPES.has(key)) unknownRecipe = true;
      }
    }
    this.unknownBreak = unknownBreak;
    this.unknownRecipe = unknownRecipe;
  }

  check(requires: readonly MacroStockFloor[]): boolean {
    for (const { item, count } of requires) {
      const held = get(this.path.stock, item);
      if (held < count) return this.fail(`requires ${count} ${item} at entry, but only ${held} are accounted for`);
    }
    for (const floor of this.policy.reserves) floorAtLeast(this.path.reserves, floor);
    const { target } = this.policy;
    if (target.kind === "preset" && target.goal === "nether_portal") {
      this.uncertain = true; // A constructed world feature is not inventory arithmetic.
      return false;
    }
    const item = target.kind === "stock" ? target.item : vanilla(target.goal);
    const count = target.kind === "stock" ? target.count : 1;
    if (!this.obtain(item, Math.max(count, get(this.path.reserves, item)))) return false;
    for (const [id, required] of this.path.reserves) if (!this.obtain(id, required)) return false;
    return true;
  }

  private fail(detail: string): false {
    this.problem ??= detail;
    return false;
  }

  private recipeFor(item: string): Recipe | undefined {
    if (!item.startsWith("minecraft:")) return;
    const key = item.slice(10);
    if (this.allowed.has(`craft:${key}`) || timberByRecipe.has(key) && this.allowed.has("craft:planks")) return RECIPES.get(key);
  }

  private hasSource(item: string) {
    return get(this.path.pickups, item) > 0 || get(this.harvests, item) > 0 || this.recipeFor(item) !== undefined;
  }

  private obtain(item: string, count: number): boolean {
    let missing = count - get(this.path.stock, item);
    if (missing <= 0) return true;
    const pickup = get(this.path.pickups, item);
    if (pickup > 0) {
      // Only an optimistic upper bound for currently witnessed drops. Never used as live inventory.
      this.path.pickups.delete(item);
      change(this.path.stock, item, pickup);
      this.path.prospective = true;
      this.path.choice = true; // Unknown drop size can change later recipe rounding.
      missing -= pickup;
      if (missing <= 0) return true;
    }
    const harvestYield = get(this.harvests, item);
    if (harvestYield > 0 && this.breaks < this.policy.maxBreaks) {
      const breaks = Math.min(this.policy.maxBreaks - this.breaks, Math.ceil(missing / harvestYield));
      const gained = breaks * harvestYield;
      this.breaks += breaks;
      change(this.path.stock, item, gained);
      this.path.prospective = true;
      if (harvestYield > 1) this.path.choice = true;
      missing -= gained;
      if (missing <= 0) return true;
    }
    const facts = this.recipeFor(item);
    if (!facts) {
      if (item === IRON_INGOT && this.allowed.has(MACRO_IRON_SMELT)) return this.smeltIron(missing);
      // Explicit pickup-only stock work can have a native source outside the bounded offer list.
      if (this.unknownBreak || this.unknownRecipe || harvestYield === 0) this.uncertain = true;
      return this.fail(`needs ${count} ${item}, but only ${count - missing} are accounted for by stock and the named effects`);
    }
    const executions = Math.ceil(missing / facts.batch);
    if (facts.bench && !this.table()) return false;
    if (this.crafts + executions > this.policy.maxCrafts) return this.fail(
      `needs ${this.crafts + executions} recipe executions, including ${executions} for ${item}, but maxCrafts is ${this.policy.maxCrafts}`);
    this.crafts += executions;
    for (const { items, count } of facts.ingredients) if (!this.spend(items, count * executions)) return false;
    change(this.path.stock, item, facts.batch * executions);
    return true;
  }

  private smeltIron(units: number): boolean {
    if (this.crafts + units > this.policy.maxCrafts) return this.fail(
      `needs ${this.crafts + units} recipe executions, including ${units} smelted units, but maxCrafts is ${this.policy.maxCrafts}`);
    this.crafts += units;
    if (!this.spend([RAW_IRON], units, true)) return false;
    const requiredTicks = units * IRON_COOK_TICKS;
    let bestFuelTicks = 0;
    let fuel: string | undefined;
    let fuelCost = 0;
    for (const [item, ticks] of MACRO_IRON_FUEL_TICKS) {
      const available = Math.max(0, Math.min(64, get(this.caps, item) - get(this.spent, item),
        get(this.path.stock, item) - get(this.path.reserves, item)));
      bestFuelTicks = Math.max(bestFuelTicks, available * ticks);
      const needed = Math.ceil(requiredTicks / ticks);
      if (needed > available) continue;
      if (fuel) this.path.choice = true;
      if (!fuel || needed < fuelCost || needed === fuelCost && item < fuel) {
        fuel = item;
        fuelCost = needed;
      }
    }
    if (!fuel) return this.fail(`needs ${requiredTicks} ticks of cold-start heat, but only ${bestFuelTicks} ticks are available from a single held fuel within the exact costCaps and above reserves`);
    if (!this.spend([fuel], fuelCost, true)) return false;
    this.path.firstFurnace ??= this.index;
    if (!this.path.existingFurnace && !this.placeStation(FURNACE, MACRO_FURNACE_PLACEMENT, "furnace")) return false;
    change(this.path.stock, IRON_INGOT, units);
    return true;
  }

  private table(): boolean {
    this.path.firstBench ??= this.index;
    if (this.path.existingTable || this.path.placedTable) return true;
    if (!this.placeStation(TABLE, `place:${TABLE}`, "crafting table")) return false;
    this.path.placedTable = true;
    return true;
  }

  private placeStation(item: string, effect: string, label: "crafting table" | "furnace"): boolean {
    if (this.placements >= this.policy.maxPlacements || !this.allowed.has(effect))
      return this.fail(`needs a usable ${label}, but no ${label === "furnace" ? "furnace " : ""}placement is permitted`);
    this.placements++;
    return this.spend([item], 1);
  }

  private spend(items: readonly string[], count: number, heldOnly = false): boolean {
    const capped = items.filter(item => get(this.caps, item) > 0);
    const relevant = capped.length ? capped : items;
    let budget = 0, held = 0, reserve = 0, used = 0;
    for (const item of relevant) {
      used += get(this.spent, item);
      budget += Math.max(0, get(this.caps, item) - get(this.spent, item));
      reserve += get(this.path.reserves, item);
      held += get(this.path.stock, item);
    }
    const name = relevant.length === 1 ? relevant[0]! : "compatible ingredients";
    if (budget < count) return this.fail(
      `needs to spend ${used + count} ${name}, but the matching costCaps permit only ${used + budget}`);
    const candidates = capped.filter(item =>
      get(this.caps, item) > get(this.spent, item) &&
      (get(this.path.stock, item) > get(this.path.reserves, item) || !heldOnly && this.hasSource(item)));
    if (candidates.length > 1) this.path.choice = true;
    let remaining = count;
    for (const item of candidates) {
      const floor = get(this.path.reserves, item);
      const debit = Math.min(remaining, get(this.caps, item) - get(this.spent, item),
        Math.max(0, get(this.path.stock, item) - floor));
      if (debit > 0) {
        change(this.path.stock, item, -debit);
        change(this.spent, item, debit);
        remaining -= debit;
      }
      if (remaining === 0) return true;
    }
    // More than one obtainable ingredient makes a failed allocation inconclusive.
    if (!heldOnly) {
      for (const item of candidates) {
        const allowance = get(this.caps, item) - get(this.spent, item);
        if (allowance <= 0 || !this.hasSource(item)) continue;
        const floor = get(this.path.reserves, item);
        const debit = Math.min(remaining, allowance);
        if (!this.obtain(item, floor + debit)) return false;
        change(this.path.stock, item, -debit);
        change(this.spent, item, debit);
        remaining -= debit;
        if (remaining === 0) return true;
      }
      if (this.unknownBreak || this.unknownRecipe) this.uncertain = true;
    }
    if (relevant.length === 1) {
      const item = name;
      const produced = held + used - get(this.start, item);
      const need = used + count + reserve - produced;
      return this.fail(`needs ${need} ${item} at entry (${used + count} to spend and ${reserve} to retain` +
        `${produced > 0 ? `, less ${produced} made or acquired in this stage` : ""}), but only ${get(this.start, item)} are accounted for`);
    }
    return this.fail(`still needs ${remaining} ${name} above the protected stock and within the exact costCaps`);
  }
}

function project(inventory: MacroObservation["inventory"], pickups: Stock, stages: readonly MacroWorkStage[],
  existingTable: boolean, existingFurnace: boolean) {
  const path: Path = { stock: new Map(Object.entries(inventory)), pickups: new Map(pickups), reserves: new Map(),
    existingTable, existingFurnace, placedTable: false, prospective: false, choice: false };
  for (let index = 0; index < stages.length; index++) {
    const { policy, requires } = stages[index]!;
    const stage = new StageArithmetic(path, policy, index);
    if (!stage.check(requires)) {
      const diagnostic = stage.problem === undefined ? undefined
        : { stageIndex: index, detail: stage.problem };
      return { path, diagnostic, incomplete: true, uncertain: stage.uncertain || path.choice };
    }
  }
  return { path, incomplete: false, uncertain: false };
}

/**
 * Test the named resource path, never admit work. A successful arithmetic projection
 * neither supplies stock nor certifies a source, screen, workstation, safety or receipt.
 */
export function preflightVanillaWork(
  { inventory, opportunities }: Pick<MacroObservation, "inventory" | "opportunities">,
  stages: readonly MacroWorkStage[],
): VanillaWorkPreflight {
  const pickups: Stock = new Map();
  const targets = new Set<string>();
  let tableInReach = false;
  let recentTable = false, recentFurnace = false;
  for (const { verb, risk, summary, evidence, material } of opportunities) {
    // The native interact offer only names a table when a usable face is in vanilla reach.
    if (verb === "interact" && risk === "guarded" && summary === `Open visible ${TABLE}`) tableInReach = true;
    if (verb === "continue" && risk === "guarded" && material?.subject.startsWith("recipe:") &&
        RECIPES.get(material.subject.slice(7))?.bench &&
        evidence.endsWith("; the table is in reach.")) tableInReach = true;
    if (verb === "survey" && risk === "read") {
      if (summary === `Reacquire recent ${TABLE}`) recentTable = true;
      if (summary === `Reacquire recent ${FURNACE}`) recentFurnace = true;
    }
    if (verb === "collect" && risk === "guarded" && material?.subject.startsWith("item:") && !targets.has(material.target)) {
      targets.add(material.target);
      change(pickups, material.subject.slice(5), 64); // The native offer does not include stack size.
    }
  }
  const existing = project(inventory, pickups, stages, true, true);
  if (existing.incomplete) {
    const diagnostic = existing.diagnostic;
    if (!diagnostic) return { kind: "unknown" };
    const detail = `Stage ${diagnostic.stageIndex + 1} ${diagnostic.detail}.` +
      (existing.uncertain ? " A different supported source or material allocation could change this." : "");
    return { kind: existing.uncertain ? "unknown" : "shortage", stageIndex: diagnostic.stageIndex, detail };
  }
  // A furnace interaction offer does not establish empty slots or cold heat.
  // Quote new placement separately; unknown station access never supplies stock.
  const { firstBench, firstFurnace } = existing.path;
  const tableWitnessed = tableInReach && (firstBench ?? firstFurnace) === 0;
  if (firstFurnace !== undefined || firstBench !== undefined && !tableWitnessed) {
    const placed = project(inventory, pickups, stages, tableWitnessed, firstFurnace === undefined);
    if (placed.incomplete) {
      const diagnostic = placed.diagnostic;
      if (!diagnostic) return { kind: "unknown" };
      const tableEvidence = firstBench === undefined || tableWitnessed ? "" : firstBench === 0
        ? " No crafting table is currently witnessed in reach."
        : " Crafting-table access is not witnessed for the later stage.";
      const clue = firstBench === 0 && !tableWitnessed && recentTable
        ? " A recent table clue permits a camera check, not access." : "";
      const furnaceClue = firstFurnace === 0 && recentFurnace
        ? " A recent furnace clue permits a camera check, not access or a cold, empty furnace." : "";
      return { kind: "unknown", stageIndex: diagnostic.stageIndex,
        detail: `Stage ${diagnostic.stageIndex + 1} on the new-station placement path ${diagnostic.detail}.` +
          tableEvidence + " A usable station in the world could avoid its placement cost." + clue + furnaceClue };
    }
    if (placed.path.prospective) return { kind: "unknown" };
  }
  return existing.path.prospective ? { kind: "unknown" } : { kind: "possible" };
}
