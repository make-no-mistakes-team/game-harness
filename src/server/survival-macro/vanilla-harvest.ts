const vanilla = (name: string) => `minecraft:${name}`;

// Vanilla 1.21.4 timber data, shared by the opening binder and work preflight.
const overworldTimber = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"] as const;
export const VANILLA_TIMBER_RECIPES: ReadonlyMap<string, string> = new Map(
  ([
    ...overworldTimber.map(species => [species, ["log", "wood"]] as const),
    ["crimson", ["stem", "hyphae"]], ["warped", ["stem", "hyphae"]], ["bamboo", ["block"]],
  ] as const).flatMap(([species, forms]) =>
    forms.flatMap(form => ["", "stripped_"].map(prefix => [vanilla(`${prefix}${species}_${form}`), `${species}_planks`] as const))),
);
export const VANILLA_HARVEST_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  [vanilla("cobblestone"), ["stone", "cobblestone"].map(vanilla)],
  [vanilla("coal"), ["coal_ore", "deepslate_coal_ore"].map(vanilla)],
]);

// Native timber obstructions permit these leaves but do not credit them as stock.
export const VANILLA_TIMBER_LEAVES: ReadonlySet<string> = new Set(
  [...overworldTimber, "azalea", "flowering_azalea"].map(species => vanilla(`${species}_leaves`)),
);

// AgentWorkOrder.harvest and prospectCoverDrop sources. Yields are upper bounds
// per authorized break, not promises of a drop or a suitable tool.
const harvests = new Map<string, { readonly item: string; readonly yield: number }>();
function harvest(item: string, blocks: readonly string[], maxYield: number) {
  for (const block of blocks) harvests.set(block, { item, yield: maxYield });
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
export const VANILLA_HARVEST: ReadonlyMap<string, { readonly item: string; readonly yield: number }> = harvests;
