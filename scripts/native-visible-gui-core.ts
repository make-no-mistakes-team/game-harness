import { requireProof, until } from "../src/evaluation/native-game.ts";
import type { VisibleScreenSnapshot } from "../src/shared/control.ts";
import type { VisibleGuiCase, VisibleGuiHarness } from "./native-visible-gui.ts";
import { runVisibleGuiWorkerCase } from "./native-visible-gui-worker.ts";

type View = VisibleScreenSnapshot;
const empty = (view: View) => view.cursor.item === null && view.cursor.count === 0;
const ownSlots = (view: View) => view.slots.filter(slot => slot.enabled && slot.slot_id >=
  (view.screen_kind === "inventory" ? 9 : view.slots.length - 36) && slot.slot_id <
  (view.screen_kind === "inventory" ? 45 : view.slots.length));
const ownCount = (view: View, item: string) => ownSlots(view).reduce((sum, slot) => sum + (slot.value.item === item ? slot.value.count : 0), 0);
function value(view: View, id: number, item: string | null, count: number) {
  const slot = view.slots.find(slot => slot.slot_id === id && slot.enabled);
  requireProof(slot?.value.item === item && slot.value.count === count, `Visible slot ${id} expected ${count} ${item}; actual ${JSON.stringify(slot)}`);
}
function own(view: View, item: string) {
  const slot = ownSlots(view).find(slot => slot.value.item === item);
  requireProof(slot, `Supplied ${item} is not in current visible own inventory`); return slot.slot_id;
}
function vacant(view: View) {
  const slot = ownSlots(view).find(slot => slot.value.item === null);
  requireProof(slot, "No current visible empty own inventory slot"); return slot.slot_id;
}

/** Privileged, finite vanilla conformance cases, not a reusable gameplay policy. */
export async function runCoreVisibleGuiCase(stage: VisibleGuiCase, entry: Record<string, unknown>, ctx: VisibleGuiHarness) {
  if (stage === "worker-api") { await runVisibleGuiWorkerCase(entry, ctx); return; }
  requireProof(["chest", "crafting", "batch-crafting", "recipe-book", "furnace", "merchant", "anvil"].includes(stage), `Unsupported core visible-GUI stage: ${stage}`);
  const observations: Array<{ label: string; view: View }> = [];
  const checks: unknown[] = [];
  entry.visible_observations = observations; entry.independent_server_checks = checks;
  entry.classification = "Privileged evaluator-authored vanilla GUI conformance, zero provider calls; not actor source or experience";
  const read = async (label: string) => {
    const view = await ctx.read(); observations.push({ label, view }); return view;
  };
  const check = async (condition: string, label: string) => { checks.push(await ctx.server(condition, label)); };
  const retained = async (item: string, count: number) => {
    const observation = await ctx.fixture.observe(); entry.retention_observation = observation;
    requireProof(observation.life.status === "alive" && observation.data.player.inventory.reduce((n, stack) => n + (stack.name === item ? stack.count : 0), 0) === count,
      `Fresh alive inventory must retain exactly ${count} ${item}`);
  };
  const productionStart = ctx.effects.length;
  if (stage === "chest") {
    entry.setup = await ctx.setup(['setblock 0 240 2 minecraft:chest{Items:[{Slot:0b,id:"minecraft:cobblestone",count:8},{Slot:2b,id:"minecraft:stone",count:3}]}']);
    entry.open = await ctx.block("chest");
    let view = await read("initial chest including empty slots");
    requireProof(view.slots.length === 63 && empty(view), "Expected ordinary single chest and empty cursor");
    value(view, 0, "cobblestone", 8); value(view, 1, null, 0); value(view, 2, "stone", 3);
    const noInput = await ctx.apply(view, []); entry.no_input = noInput;
    requireProof(noInput.status === "succeeded", "Scoped no-input action did not succeed");
    const persisted = await read("read and zero-input preserve the open chest");
    requireProof(JSON.stringify(persisted) === JSON.stringify(view), "Read/no-input mutated persistent chest contents or layout");
    await ctx.slot(0, "right"); view = await read("right pickup owns half on cursor");
    value(view, 0, "cobblestone", 4); requireProof(view.cursor.item === "cobblestone" && view.cursor.count === 4, "Right pickup did not split custody 4/4");
    await ctx.slot(1, "right"); view = await read("right placement deposits one");
    value(view, 1, "cobblestone", 1); requireProof(view.cursor.count === 3, "Right placement did not retain three on cursor");
    await ctx.slot(1); view = await read("left placement merges remaining cursor"); value(view, 1, "cobblestone", 4); requireProof(empty(view), "Left merge left cursor custody");
    await ctx.slot(0); view = await read("left pickup before ordinary transfer");
    value(view, 0, null, 0);
    requireProof(view.cursor.item === "cobblestone" && view.cursor.count === 4, "Left pickup did not transfer all four into actual cursor custody");
    const destination = vacant(view); await ctx.slot(destination);
    await ctx.slot(1, "left", "shift"); view = await read("vanilla shift transfer into own slots");
    requireProof(empty(view) && ownCount(view, "cobblestone") === 8, "Ordinary and shift transfers did not conserve eight cobblestone"); value(view, 1, null, 0);
    const hotbarId = view.slots.length - 9 + 2; value(view, hotbarId, null, 0);
    await ctx.slot(2, "left", "hotbar", 2); view = await read("ordinary hotbar number swap");
    value(view, 2, null, 0); value(view, hotbarId, "stone", 3);
    for (let remaining = 2; remaining > 0; remaining--) {
      view = await read("select current own cobblestone for return");
      const source = ownSlots(view).find(slot => slot.value.item === "cobblestone");
      if (!source) break;
      await ctx.slot(source.slot_id, "left", "shift");
    }
    view = await read("all custody conserved before explicit close");
    requireProof(empty(view) && ownCount(view, "cobblestone") === 0 && ownCount(view, "stone") === 3, "Chest return lost or duplicated items");
    value(view, 0, "cobblestone", 8);
    entry.close = await ctx.close();
    await check('if data block 0 240 2 Items[{Slot:0b,id:"minecraft:cobblestone",count:8}] unless data block 0 240 2 Items[{id:"minecraft:stone"}] if data entity @a[limit=1] Inventory[{Slot:2b,id:"minecraft:stone",count:3}] unless items entity @a[limit=1] inventory.* minecraft:cobblestone unless items entity @a[limit=1] hotbar.* minecraft:cobblestone', "Server chest eight cobblestone, own hotbar three stone, no duplicate cobblestone");
    await retained("stone", 3); return;
  }
  if (stage === "crafting") {
    entry.setup = await ctx.setup(["give @a minecraft:oak_planks 4"]); const opened = await ctx.inventory(); entry.open = opened;
    requireProof(opened.status === "succeeded", "Ordinary crafting inventory open did not settle successfully");
    let view = await read("supplied four planks in inventory 2x2");
    requireProof(view.screen_kind === "inventory" && ownCount(view, "oak_planks") === 4 && empty(view), "Expected four supplied planks and inventory 2x2");
    const source = own(view, "oak_planks"); for (const id of [1, 2, 3, 4]) value(view, id, null, 0);
    await ctx.slot(source);
    for (const id of [1, 2, 3, 4]) await ctx.slot(id, "right");
    view = await read("actual 2x2 result before take"); value(view, 0, "crafting_table", 1); requireProof(empty(view), "Four single placements did not exhaust supplied cursor");
    await ctx.slot(0); view = await read("server result taken into cursor, not retained yet");
    requireProof(view.cursor.item === "crafting_table" && view.cursor.count === 1 && ownCount(view, "crafting_table") === 0, "Crafting source/cursor custody missing");
    ctx.production(productionStart, "crafting", "crafting_table", 1);
    await ctx.slot(vacant(view)); view = await read("crafted table retained in own visible inventory");
    requireProof(empty(view) && ownCount(view, "crafting_table") === 1 && ownCount(view, "oak_planks") === 0, "Crafting retention or input consumption mismatch");
    entry.close = await ctx.close(); await retained("crafting_table", 1);
    await check('if data entity @a[limit=1] Inventory[{id:"minecraft:crafting_table",count:1}] unless items entity @a[limit=1] inventory.* minecraft:oak_planks unless items entity @a[limit=1] hotbar.* minecraft:oak_planks', "Actual four planks consumed and one table retained"); return;
  }
  if (stage === "batch-crafting") {
    const batches: Record<string, unknown>[] = []; entry.batches = batches;
    for (const count of [32, 33, 64]) {
      const from = ctx.effects.length, batch: Record<string, unknown> = { input_logs: count, expected_planks: count * 4 };
      batches.push(batch);
      batch.setup = await ctx.setup(["clear @a", `give @a minecraft:oak_log ${count}`]);
      batch.open = await ctx.inventory();
      let view = await read(`actual ${count}-log batch input`);
      await ctx.slot(own(view, "oak_log")); await ctx.slot(1);
      view = await read(`actual four-plank recipe for ${count} input logs`);
      value(view, 1, "oak_log", count); value(view, 0, "oak_planks", 4);
      const taken = await ctx.slot(0, "left", "shift"); batch.take = taken;
      ctx.production(from, "crafting", "oak_planks", count * 4);
      view = await read(`retained complete ${count}-event shift-craft`);
      requireProof(empty(view) && ownCount(view, "oak_planks") === count * 4 && ownCount(view, "oak_log") === 0,
        "Shift-craft batch lost, duplicated or left carried output");
      value(view, 1, null, 0); value(view, 0, null, 0);
      batch.close = await ctx.close(); await retained("oak_planks", count * 4);
      batch.count_setup = await ctx.setup(["scoreboard objectives add gh_gui_batch dummy",
        "execute store result score gh_planks gh_gui_batch run clear @p minecraft:oak_planks 0"]);
      await check(`if score gh_planks gh_gui_batch matches ${count * 4} unless items entity @p inventory.* minecraft:oak_log unless items entity @p hotbar.* minecraft:oak_log`,
        `Actual ${count} log batch produced and retained exactly ${count * 4} planks`);
    }
    return;
  }
  if (stage === "recipe-book") {
    entry.setup = await ctx.setup(["give @a minecraft:oak_planks 4", "recipe give @a minecraft:crafting_table"]); const opened = await ctx.inventory(); entry.open = opened;
    requireProof(opened.status === "succeeded", "Ordinary recipe-book inventory open did not settle successfully");
    let view = await read("current inventory recipe-book toggle");
    let toggle = view.elements.find(element => element.enabled && element.text === "recipe_book_toggle");
    if (view.elements.some(element => element.kind === "recipe")) {
      requireProof(toggle, "Rendered open book has no visible toggle"); await ctx.click(toggle.element_id);
      view = await read("explicitly close previously persisted book before open selection");
      toggle = view.elements.find(element => element.enabled && element.text === "recipe_book_toggle");
    }
    requireProof(toggle, "Actually rendered recipe-book toggle missing"); await ctx.click(toggle.element_id);
    view = await read("current rendered recipe choices after explicit toggle");
    const recipe = view.elements.find(element => element.enabled && element.kind === "recipe" && element.text === "1 crafting_table");
    requireProof(recipe, "Crafting table is not a current actually rendered recipe choice"); entry.selected_recipe = recipe;
    await ctx.click(recipe.element_id); view = await read("vanilla fill after selected visible recipe");
    value(view, 0, "crafting_table", 1); for (const id of [1, 2, 3, 4]) value(view, id, "oak_planks", 1);
    requireProof(view.elements.some(element => element.kind === "recipe"), "Recipe book closed unexpectedly after recipe fill");
    await ctx.slot(0); view = await read("recipe-book production on cursor");
    requireProof(view.cursor.item === "crafting_table" && view.cursor.count === 1, "Selected recipe result not actually taken");
    ctx.production(productionStart, "crafting", "crafting_table", 1);
    await ctx.slot(vacant(view)); view = await read("recipe book stays open with retained output");
    requireProof(empty(view) && ownCount(view, "crafting_table") === 1 && view.elements.some(element => element.kind === "recipe"), "Book did not persist until authored close");
    entry.close = await ctx.close(); await retained("crafting_table", 1);
    await check('if data entity @a[limit=1] Inventory[{id:"minecraft:crafting_table",count:1}] unless items entity @a[limit=1] inventory.* minecraft:oak_planks unless items entity @a[limit=1] hotbar.* minecraft:oak_planks', "Selected recipe consumed four planks and retained one table"); return;
  }
  if (stage === "furnace") {
    entry.setup = await ctx.setup(["setblock 0 240 2 minecraft:furnace", "setblock 2 240 2 minecraft:oak_log", "give @a minecraft:iron_ore 3", "give @a minecraft:coal 1", "gamerule doDaylightCycle true"]);
    entry.open = await ctx.block("furnace"); let view = await read("genuine initially empty furnace");
    requireProof(ownCount(view, "iron_ore") === 3 && ownCount(view, "coal") === 1 && empty(view), "Furnace fixture requires three genuine supplied ores, one coal and empty cursor");
    for (const id of [0, 1, 2]) value(view, id, null, 0);
    const oreSource = own(view, "iron_ore");
    await ctx.slot(oreSource); await ctx.slot(0, "right"); await ctx.slot(0, "right"); await ctx.slot(oreSource);
    view = await read("two ores loaded with one separately retained for ordinary top-up"); value(view, 0, "iron_ore", 2);
    await ctx.slot(own(view, "coal")); await ctx.slot(1); view = await read("coal loaded through visible fuel slot"); requireProof(empty(view), "Fuel load left cursor custody");
    await ctx.slot(own(view, "iron_ore")); await ctx.slot(0); view = await read("conserved same-player nonempty furnace top-up");
    value(view, 0, "iron_ore", 3); requireProof(empty(view) && ownCount(view, "iron_ore") === 0, "Ordinary furnace top-up did not conserve input");
    entry.leave = await ctx.close(); entry.before_work = await ctx.fixture.observe();
    const log = (await ctx.fixture.observe()).data.blocks.find(block => block.current && block.name === "oak_log" && Math.floor(block.position.x) === 2 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 2);
    requireProof(log, "Nearby ordinary work target missing from authorized observation");
    const work = await ctx.fixture.action({ kind: "dig", target: log.target }, 15_000, ctx.signal); entry.nearby_work = work;
    requireProof(work.status === "succeeded" && await ctx.maybeRead() === null, "Ordinary nearby world work did not complete while furnace ran");
    entry.return = await ctx.block("furnace");
    view = await until(() => read("independent furnace output progress sample"), current => current.slots.some(slot => slot.slot_id === 2 && slot.value.item === "iron_ingot" && slot.value.count === 3), 30_000, "Genuine three-ore smelting after top-up did not complete");
    value(view, 0, null, 0); value(view, 2, "iron_ingot", 3);
    await ctx.slot(2); view = await read("actual smelted output taken into cursor");
    requireProof(view.cursor.item === "iron_ingot" && view.cursor.count === 3, "Smelted output cursor take missing"); ctx.production(productionStart, "smelting", "iron_ingot", 3);
    await ctx.slot(vacant(view)); entry.close = await ctx.close(); await retained("iron_ingot", 3);
    await check('if data entity @a[limit=1] Inventory[{id:"minecraft:iron_ingot",count:3}] unless data block 0 240 2 Items[{Slot:0b}] unless data block 0 240 2 Items[{Slot:2b}] unless items entity @a[limit=1] inventory.* minecraft:iron_ore unless items entity @a[limit=1] hotbar.* minecraft:iron_ore if block 2 240 2 minecraft:air', "Three genuine ores including conserved top-up consumed, three ingots retained, nearby log actually removed"); return;
  }
  if (stage === "merchant") {
    const recipes = ["apple", "coal", "stick", "stone", "dirt", "sand", "gravel", "flint", "bread"].map(item =>
      `{buy:{id:"minecraft:emerald",count:1},sell:{id:"minecraft:${item}",count:${item === "bread" ? 3 : 1}},uses:0,maxUses:2,rewardExp:0b,priceMultiplier:0.0f,demand:0,specialPrice:0}`);
    entry.setup = await ctx.setup([`summon minecraft:villager 0.5 240 2.5 {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Tags:["gh_gui_trade"],VillagerData:{type:"minecraft:plains",profession:"minecraft:farmer",level:1},Offers:{Recipes:[${recipes.join(",")}]}}`, "give @a minecraft:emerald 1"]);
    const observation = await ctx.fixture.observe(); entry.opening_observation = observation;
    const villager = observation.data.entities.find(entity => entity.current && entity.name === "villager");
    requireProof(villager, "Prepared merchant is absent from current authorized entities");
    const opened = await ctx.fixture.action({ kind: "interact", target: villager.target }, 12_000, ctx.signal); entry.open = opened;
    requireProof(opened.status === "succeeded", "Visible villager interaction failed");
    let view = await read("only actual first merchant page"); requireProof(view.screen_kind === "merchant", "Expected merchant screen");
    const initialOffers = view.elements.filter(element => element.enabled && element.kind === "trade_offer");
    requireProof(initialOffers.length === 7 && !initialOffers.some(element => element.text.includes("3 bread")),
      "Merchant exposed hidden offers instead of only seven actually rendered rows");
    const scroll = view.elements.find(element => element.enabled && element.kind === "scroll_region");
    requireProof(scroll, "Multi-page merchant omitted its actual scrolling region");
    const beforeScroll = view;
    entry.scroll = await ctx.apply(view, [{ kind: "scroll", element_id: scroll.element_id, horizontal: 0, vertical: -16 }]);
    requireProof((entry.scroll as { status: string }).status === "succeeded", "Ordinary merchant wheel did not settle");
    view = await read("new actually rendered merchant page");
    requireProof(view.identity.layout_revision !== beforeScroll.identity.layout_revision, "Merchant page did not retire the old layout");
    const retired = initialOffers.find(old => !view.elements.some(current => current.element_id === old.element_id));
    requireProof(retired, "Merchant scroll did not retire any previous row binding");
    const custody = JSON.stringify({ slots: view.slots, cursor: view.cursor });
    const refused = await ctx.apply(view, [{ kind: "element", element_id: retired.element_id, button: "left" }]);
    entry.retired_offer_refusal = refused;
    const refusedEvidence = refused.evidence as Record<string, unknown>;
    requireProof(refused.status === "failed" && refusedEvidence.world_effect_emitted === false && refusedEvidence.mutation_count === 0,
      "Retired merchant row binding was not refused before input");
    view = await read("merchant custody after stale-row refusal");
    requireProof(JSON.stringify({ slots: view.slots, cursor: view.cursor }) === custody, "Stale merchant row changed item custody");
    const offer = view.elements.find(element => element.enabled && element.kind === "trade_offer" &&
      element.text.includes("1 emerald") && element.text.includes("3 bread"));
    requireProof(offer, "Expected bread offer on the newly rendered page");
    entry.selected_offer = offer; await ctx.click(offer.element_id); view = await read("explicit selected offer and vanilla payment fill");
    requireProof(view.elements.some(element => element.kind === "trade_offer" && element.text.startsWith("selected ")), "Offer selection did not persist visibly");
    value(view, 0, "emerald", 1); value(view, 2, "bread", 3);
    await ctx.slot(2); view = await read("single ordinary merchant result take");
    requireProof(view.cursor.item === "bread" && view.cursor.count === 3, "Trade did not produce exactly three bread on cursor"); ctx.production(productionStart, "trading", "bread", 3);
    await ctx.slot(vacant(view)); view = await read("trade retained with exactly one payment consumed");
    requireProof(empty(view) && ownCount(view, "bread") === 3 && ownCount(view, "emerald") === 0, "Merchant inventory conservation failed"); value(view, 0, null, 0);
    entry.close = await ctx.close(); await retained("bread", 3);
    await check('if data entity @e[type=minecraft:villager,tag=gh_gui_trade,limit=1] Offers.Recipes[{sell:{id:"minecraft:bread"},uses:1,maxUses:2}] unless data entity @e[type=minecraft:villager,tag=gh_gui_trade,limit=1] Offers.Recipes[{sell:{count:1},uses:1}] if data entity @a[limit=1] Inventory[{id:"minecraft:bread",count:3}] unless items entity @a[limit=1] inventory.* minecraft:emerald unless items entity @a[limit=1] hotbar.* minecraft:emerald', "Only newly rendered bread offer used once, one emerald consumed, three bread retained");
    entry.one_page_setup = await ctx.setup([`data modify entity @e[type=minecraft:villager,tag=gh_gui_trade,limit=1] Offers.Recipes set value [${recipes[0]}]`]);
    const freshVillager = (await ctx.fixture.observe()).data.entities.find(entity => entity.current && entity.name === "villager");
    requireProof(freshVillager, "Single-page merchant lost fresh visible target");
    entry.one_page_open = await ctx.fixture.action({ kind: "interact", target: freshVillager.target }, 12_000, ctx.signal);
    view = await read("actual single-page merchant has no active scrolling region");
    requireProof(view.elements.filter(element => element.kind === "trade_offer").length === 1 &&
      !view.elements.some(element => element.kind === "scroll_region"), "One-page merchant fabricated active scrolling");
    entry.one_page_close = await ctx.close(); return;
  }
  entry.setup = await ctx.setup(["setblock 0 240 2 minecraft:anvil", "give @a minecraft:iron_sword 1", "experience set @a 10 levels"]);
  entry.open = await ctx.block("anvil"); let view = await read("visible anvil and supplied sword");
  await ctx.slot(own(view, "iron_sword")); await ctx.slot(0); view = await read("loaded sword with actual visible name field");
  const field = view.elements.find(element => element.enabled && element.kind === "text"); requireProof(field, "Actual vanilla anvil text field missing");
  await ctx.click(field.element_id); view = await read("ordinary focused anvil field");
  const rename = await ctx.apply(view, [
    { kind: "key", key: "home", phase: "press" }, { kind: "key", key: "home", phase: "release" },
    { kind: "key", key: "shift", phase: "press" }, { kind: "key", key: "end", phase: "press" },
    { kind: "key", key: "end", phase: "release" }, { kind: "key", key: "shift", phase: "release" },
    { kind: "text", element_id: field.element_id, text: "Proof Sword" },
  ]);
  entry.rename = rename;
  requireProof(rename.status === "succeeded", "Ordinary Home/Shift+End/typing did not succeed");
  view = await read("actual renamed anvil output"); requireProof(view.elements.some(element => element.kind === "text" && element.text === "Proof Sword"), "Visible anvil name text mismatch"); value(view, 2, "iron_sword", 1);
  await ctx.slot(2); view = await read("actual renamed result taken");
  requireProof(view.cursor.item === "iron_sword" && view.cursor.count === 1, "Anvil result cursor custody missing"); ctx.production(productionStart, "anvil", "iron_sword", 1);
  await ctx.slot(vacant(view)); entry.close = await ctx.close(); await retained("iron_sword", 1);
  await check('if items entity @a[limit=1] inventory.* minecraft:iron_sword[minecraft:custom_name=\'"Proof Sword"\']', "Independent server actual custom name is Proof Sword");
}
