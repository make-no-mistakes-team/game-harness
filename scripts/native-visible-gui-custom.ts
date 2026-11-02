import { pause, requireProof } from "../src/evaluation/native-game.ts";
import type { VisibleScreenOperation, VisibleScreenSnapshot } from "../src/shared/control.ts";
import type { VisibleGuiCase, VisibleGuiHarness } from "./native-visible-gui.ts";

type View = VisibleScreenSnapshot;
type Element = View["elements"][number];

/** Privileged, explicit vanilla conformance cases, never an actor policy or experience source. */
export async function runCustomVisibleGuiCase(stage: VisibleGuiCase, entry: Record<string, unknown>, ctx: VisibleGuiHarness) {
  requireProof(["stonecutter", "loom", "enchanting", "beacon"].includes(stage), `Unsupported custom visible GUI stage: ${stage}`);
  const observations: Record<string, unknown>[] = [], operations: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [], checks: Record<string, unknown>[] = [];
  const effectStart = ctx.effects.length;
  entry.observations = observations; entry.operations = operations; entry.privileged_commands = commands;
  entry.independent_server_checks = checks;
  entry.source_confidence = {
    choices: "Only current actual rendered labels, enabled state, slot values and ids from minecraft.visible_screen@1",
    inputs: "Explicit evaluator-authored ordinary pointer/slot/element/wheel operations; not autonomous model gameplay",
    consequences: "Disclosed independent privileged server assertions after ordinary input; never supplied to choice selection",
    production: "No custom-mechanism producer attribution is invented; core fixtures separately prove registered producers",
  };
  const setup = async (label: string, lines: string[]) => {
    const record: Record<string, unknown> = { label, commands: lines }; commands.push(record);
    const from = ctx.fixture.commands.length;
    try { const output = await ctx.setup(lines); record.output = output; return output; }
    finally { record.raw_console = ctx.fixture.commands.slice(from); }
  };
  const server = async (condition: string, label: string) => {
    const record: Record<string, unknown> = { label, condition }; checks.push(record);
    const from = ctx.fixture.commands.length;
    try { record.receipt = await ctx.server(condition, label); }
    finally { record.raw_console = ctx.fixture.commands.slice(from); }
  };
  const read = async (label: string) => {
    ctx.signal.throwIfAborted();
    const view = await ctx.read(); observations.push({ label, view });
    requireProof(view.screen_kind === stage, `Expected actual ${stage} view, got ${view.screen_kind}`);
    return view;
  };
  const waitView = async (label: string, predicate: (view: View) => boolean, attempts = 40) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const view = await read(`${label}:${attempt}`);
      if (predicate(view)) return view;
      await pause(150);
    }
    throw new Error(`Current rendered consequence did not appear: ${label}`);
  };
  const apply = async (label: string, view: View, inputs: VisibleScreenOperation[], success = true) => {
    const record: Record<string, unknown> = { label, view, operations: inputs }; operations.push(record);
    const from = ctx.effects.length;
    try {
      const receipt = await ctx.apply(view, inputs); record.receipt = receipt;
      if (success) requireProof(receipt.status === "succeeded", `${label}: ${receipt.status}: ${receipt.summary}`);
      return receipt;
    } finally { record.raw_effects = ctx.effects.slice(from); }
  };
  const own = (view: View) => {
    requireProof(view.slots.length >= 36, "Custom handled view omitted the visible own inventory");
    return view.slots.slice(-36);
  };
  const machine = (view: View, expected: number) => {
    const slots = view.slots.slice(0, -36);
    requireProof(slots.length === expected, `Unexpected actual ${stage} workstation slot layout`);
    return slots;
  };
  const slot = async (label: string, view: View, id: number) => {
    const selected = view.slots.find(value => value.slot_id === id);
    requireProof(selected?.enabled, `${label}: selected slot is not current and enabled`);
    return apply(label, view, [{ kind: "slot", slot_id: selected.slot_id, button: "left", mode: "ordinary", hotbar_slot: null,
      expected_cursor: view.cursor, expected_slots: [{ slot_id: selected.slot_id, value: selected.value }] }]);
  };
  const put = async (item: string, inputIndex: number, slotCount: number) => {
    let view = await read(`choose own ${item}`);
    requireProof(view.cursor.item === null, "Ingredient transfer started with unexpected cursor custody");
    const source = own(view).find(value => value.enabled && value.value.item === item);
    requireProof(source, `Prepared own ${item} is not currently visible`);
    await slot(`pick up own ${item}`, view, source.slot_id);
    view = await read(`place ${item}`);
    const destination = machine(view, slotCount)[inputIndex];
    requireProof(destination?.enabled && destination.value.item === null && view.cursor.item === item,
      `Actual input/cursor for ${item} does not match the prepared transfer`);
    await slot(`place actual ${item} input`, view, destination.slot_id);
    view = await read(`confirm ${item} input`);
    requireProof(view.cursor.item === null && machine(view, slotCount)[inputIndex]?.value.item === item,
      `Ordinary ${item} input transfer did not settle`);
  };
  const choose = async (label: string, view: View, element: Element) => {
    requireProof(view.elements.some(value => value.element_id === element.element_id && value.enabled && value.kind === "choice"),
      `${label}: choice is not on the current rendered page`);
    entry.selected_rows ??= [];
    (entry.selected_rows as unknown[]).push({ label, identity: view.identity, element });
    return apply(label, view, [{ kind: "element", element_id: element.element_id, button: "left" }]);
  };
  const wheel = async (label: string, view: View, text: string, vertical: number) => {
    const region = view.elements.find(value => value.kind === "scroll_region" && value.enabled && value.text === text);
    requireProof(region, `Actual rendered scroll region missing: ${text}`);
    await apply(label, view, [{ kind: "scroll", element_id: region.element_id, horizontal: 0, vertical }]);
    return read(`${label}:after`);
  };
  const retain = async (item: string, outputIndex: number, slotCount: number) => {
    let view = await waitView(`actual ${item} result`, value => machine(value, slotCount)[outputIndex]?.value.item === item);
    const output = machine(view, slotCount)[outputIndex]!;
    requireProof(view.cursor.item === null && output.enabled && output.value.count === 1, `Unexpected actual ${item} result custody`);
    await slot(`take actual ${item} result`, view, output.slot_id);
    view = await read(`retain ${item} result`);
    requireProof(view.cursor.item === item && view.cursor.count === 1, `Actual ${item} result was not taken into cursor`);
    const destination = own(view).find(value => value.enabled && value.value.item === null);
    requireProof(destination, `No current visible own slot to retain ${item}`);
    await slot(`put ${item} into own inventory`, view, destination.slot_id);
    view = await read(`confirmed retained ${item}`);
    requireProof(view.cursor.item === null && own(view).some(value => value.value.item === item && value.value.count === 1),
      `Actual ${item} result was not retained in own inventory`);
    entry.retained_result = { item, view };
  };
  const close = async () => {
    const view = await read("explicit close with empty cursor");
    requireProof(view.cursor.item === null, "Custom case cannot discard unaccounted cursor custody");
    await apply("ordinary explicit close", view, [{ kind: "close" }]);
    const after = await ctx.maybeRead(); entry.after_close = after;
    requireProof(after === null, "Actual custom screen remained open after explicit close");
  };
  const counts = async (expected: Record<string, number>) => {
    for (const [item, count] of Object.entries(expected)) {
      // Vanilla clear with maxCount=0 counts only; it does not remove or grant any item.
      await setup(`independent own ${item} count`, [
        `execute store result score gh_${item} gh_gui_count run clear @p minecraft:${item} 0`,
      ]);
      await server(`if score gh_${item} gh_gui_count matches ${count}`, `Exact independent retained ${item} count is ${count}`);
    }
    await server("unless entity @e[type=minecraft:item,x=-12,y=238,z=-12,dx=24,dy=12,dz=24]",
      "No output or ingredient was dropped in the owned GUI arena instead of conserved");
  };
  try {
    await setup("fixed evaluator authority and count objective", ["gamemode survival @a", "scoreboard objectives add gh_gui_count dummy"]);
    if (stage === "stonecutter") {
      await setup("fixed stonecutter and own stone supply", ["setblock 0 240 2 minecraft:stonecutter", "give @a minecraft:stone 4"]);
      entry.open_receipt = await ctx.block("stonecutter");
      await put("stone", 0, 2);
      let view = await waitView("rendered stone recipes", value => value.elements.some(element => element.kind === "choice" && element.enabled));
      const region = view.elements.find(element => element.kind === "scroll_region" && element.text === "stonecutter recipes" && element.enabled);
      if (region) {
        const before = view;
        view = await wheel("normal stone recipe wheel down", view, "stonecutter recipes", -1);
        requireProof(view.identity.layout_revision !== before.identity.layout_revision, "Scrollable stone grid did not change its rendered page binding");
      }
      let selected = view.elements.find(element => element.enabled && element.kind === "choice" && /^(?:selected )?1 stone_bricks$/.test(element.text));
      if (!selected && region) {
        view = await wheel("normal stone recipe wheel up", view, "stonecutter recipes", 1);
        selected = view.elements.find(element => element.enabled && element.kind === "choice" && /^(?:selected )?1 stone_bricks$/.test(element.text));
      }
      requireProof(selected, "stone_bricks was not actually rendered on the observed stonecutter pages");
      await choose("choose rendered stone_bricks", view, selected);
      await retain("stone_bricks", 1, 2);
      await close();
      await counts({ stone: 3, stone_bricks: 1 });
    } else if (stage === "loom") {
      await setup("fixed loom and own plain banner/dye", ["setblock 0 240 2 minecraft:loom", "give @a minecraft:white_banner 1", "give @a minecraft:red_dye 1"]);
      entry.open_receipt = await ctx.block("loom");
      await put("white_banner", 0, 4); await put("red_dye", 1, 4);
      let view = await waitView("rendered loom patterns", value => value.elements.some(element => element.enabled && element.kind === "choice"));
      const initial = view.elements.find(element => element.enabled && element.kind === "choice" && /^(?:selected )?minecraft:[a-z0-9_/]+$/.test(element.text));
      requireProof(initial, "No actual current-page loom pattern is available");
      await choose("choose actual initial rendered loom pattern", view, initial);
      view = await waitView("selected initial loom pattern", value => value.elements.some(element => element.text === `selected ${initial.text.replace(/^selected /, "")}`));
      const beforeScroll = view;
      const oldChoices = beforeScroll.elements.filter(element => element.kind === "choice");
      view = await wheel("normal loom pattern wheel to new page", view, "loom patterns", -16);
      requireProof(view.identity.layout_revision !== beforeScroll.identity.layout_revision, "Loom wheel did not invalidate the previous page layout");
      const retired = oldChoices.find(old => !view.elements.some(element => element.element_id === old.element_id));
      const fresh = view.elements.find(element => element.enabled && element.kind === "choice" &&
        !oldChoices.some(old => old.text.replace(/^selected /, "") === element.text.replace(/^selected /, "")));
      requireProof(retired && fresh, "Loom did not expose a genuinely new rendered pattern page and retire an old binding");
      const custody = JSON.stringify({ slots: view.slots, cursor: view.cursor });
      const rejected = await apply("reject retired loom element id against current layout", view,
        [{ kind: "element", element_id: retired.element_id, button: "left" }], false);
      const rejectedEvidence = rejected.evidence;
      requireProof(rejected.status === "failed" && rejectedEvidence !== null && typeof rejectedEvidence === "object" &&
        "world_effect_emitted" in rejectedEvidence && rejectedEvidence.world_effect_emitted === false &&
        "applied_prefix" in rejectedEvidence && rejectedEvidence.applied_prefix === 0 &&
        "mutation_count" in rejectedEvidence && rejectedEvidence.mutation_count === 0,
      "Retired loom binding was not refused without emitted input");
      view = await read("loom state after retired-binding refusal");
      requireProof(JSON.stringify({ slots: view.slots, cursor: view.cursor }) === custody,
        "Retired loom binding changed actual item custody");
      const current = view.elements.find(element => element.enabled && element.element_id === fresh.element_id && element.text === fresh.text);
      requireProof(current, "New loom pattern is no longer an actually current rendered choice");
      const pattern = current.text.replace(/^selected /, "");
      requireProof(/^minecraft:[a-z0-9_/]+$/.test(pattern), "Rendered pattern asset identifier is not bounded vanilla syntax");
      entry.actual_selected_pattern = pattern;
      await choose("choose actual newly rendered loom pattern", view, current);
      await retain("white_banner", 3, 4); await close();
      await counts({ white_banner: 1, red_dye: 0 });
      await server(`if data entity @p Inventory[{id:"minecraft:white_banner"}].components."minecraft:banner_patterns"[{pattern:"${pattern}",color:"red"}]`,
        "Retained actual banner has the newly selected rendered pattern with red dye");
      await setup("independent actual banner pattern component length", [
        'execute store result score gh_patterns gh_gui_count run data get entity @p Inventory[{id:"minecraft:white_banner"}].components."minecraft:banner_patterns"',
      ]);
      await server("if score gh_patterns gh_gui_count matches 1", "Plain input acquired exactly one actual banner pattern");
    } else if (stage === "enchanting") {
      await setup("fixed valid table, fifteen accessible shelves, own book/lapis and level thirty", [
        "setblock 0 240 2 minecraft:enchanting_table", "fill -2 240 0 -2 240 4 minecraft:bookshelf",
        "fill 2 240 0 2 240 4 minecraft:bookshelf", "fill -1 240 4 1 240 4 minecraft:bookshelf",
        "fill -1 241 4 0 241 4 minecraft:bookshelf", "give @a minecraft:book 1", "give @a minecraft:lapis_lazuli 3",
        "experience set @a 30 levels", "experience set @a 0 points",
      ]);
      entry.open_receipt = await ctx.block("enchanting_table");
      await put("book", 0, 2); await put("lapis_lazuli", 1, 2);
      const view = await waitView("actual enabled drawn enchant cost and runes", value => value.elements.some(element =>
        element.enabled && element.kind === "choice" && /^option [1-3] level [1-9][0-9]* runes .+/.test(element.text)));
      const selected = view.elements.find(element => element.enabled && element.kind === "choice" &&
        /^option [1-3] level [1-9][0-9]* runes .+/.test(element.text));
      requireProof(selected, "No enabled actually drawn enchantment option");
      const drawn = /^option ([1-3]) level ([1-9][0-9]*) runes (.+)$/.exec(selected.text);
      requireProof(drawn && Number(drawn[2]) <= 30, "Prepared XP does not meet the actual rendered enchantment requirement");
      const paid = Number(drawn[1]);
      entry.enchantment_choice = { actual_rendered_label: selected.text, required_level: Number(drawn[2]), paid_levels_and_lapis: paid,
        undisplayed_hints_queried: false, enchantment_seed_queried: false };
      await choose("choose enabled actual drawn enchantment row", view, selected);
      await retain("enchanted_book", 0, 2); await close();
      await counts({ book: 0, enchanted_book: 1, lapis_lazuli: 3 - paid });
      await server(`if data entity @p {XpLevel:${30 - paid}}`, "Actual server XP level cost matches the selected vanilla row");
      await setup("independent actual applied stored enchantments", [
        'execute store result score gh_enchants gh_gui_count run data get entity @p Inventory[{id:"minecraft:enchanted_book"}].components."minecraft:stored_enchantments".levels',
      ]);
      await server("if score gh_enchants gh_gui_count matches 1..", "Retained actual enchanted book has nonempty server-applied enchantments");
    } else {
      await setup("fixed valid one-level beacon pyramid and own payment", [
        "fill -1 239 1 1 239 3 minecraft:iron_block", "setblock 0 240 2 minecraft:beacon", "give @a minecraft:emerald 1",
      ]);
      entry.open_receipt = await ctx.block("beacon");
      await waitView("actual beacon pyramid activation before payment input", value => value.elements.some(element =>
        element.enabled && element.kind === "choice" && /^(?:selected )?primary speed$/.test(element.text)), 80);
      await put("emerald", 0, 1);
      let view = await waitView("actual enabled rendered primary speed", value => value.elements.some(element =>
        element.enabled && element.kind === "choice" && /^(?:selected )?primary speed$/.test(element.text)), 80);
      const speed = view.elements.find(element => element.enabled && element.kind === "choice" && /^(?:selected )?primary speed$/.test(element.text));
      requireProof(speed, "Prepared beacon has no actual enabled speed icon");
      await choose("choose actual rendered primary speed", view, speed);
      view = await waitView("actual selected speed and enabled real Done", value =>
        value.elements.some(element => element.kind === "choice" && element.text === "selected primary speed") &&
        value.elements.some(element => element.kind === "button" && element.text === "Done" && element.enabled));
      const done = view.elements.find(element => element.kind === "button" && element.text === "Done" && element.enabled);
      requireProof(done, "Actual enabled vanilla Done widget is missing");
      entry.beacon_done_widget = done;
      const receipt = await apply("ordinary real beacon Done exactly once", view,
        [{ kind: "element", element_id: done.element_id, button: "left" }], false);
      const evidence = receipt.evidence;
      requireProof(receipt.status === "succeeded" || receipt.status === "unknown" && evidence !== null && typeof evidence === "object" &&
        "world_effect_emitted" in evidence && evidence.world_effect_emitted === true,
      `Beacon Done did not emit ordinary input: ${receipt.status}: ${receipt.summary}`);
      entry.beacon_terminal_receipt_status = receipt.status;
      entry.beacon_finish_policy = "Closing press may lose matching-handler finish ACK; unknown remains unknown, no replay or fabricated producer confirmation";
      for (let attempt = 0; attempt < 40; attempt++) {
        const current = await ctx.maybeRead(); observations.push({ label: `beacon close:${attempt}`, view: current });
        if (current === null) break;
        requireProof(attempt < 39, "Actual beacon Done did not close its handler"); await pause(150);
      }
      // Poll only an independently read delayed server consequence. Never repeat Done or effect selection.
      const marker = `gh_beacon_${crypto.randomUUID().replaceAll("-", "")}`;
      let effectSeen = false;
      for (let attempt = 0; attempt < 24; attempt++) {
        ctx.signal.throwIfAborted();
        const output = await setup(`independent delayed beacon effect:${attempt}`, [
          `execute if data entity @p active_effects[{id:"minecraft:speed"}] run say ${marker}`,
        ]);
        if (output.includes(marker)) { effectSeen = true; break; }
        await pause(250);
      }
      requireProof(effectSeen, "Actual server never applied the selected beacon speed effect");
      await counts({ emerald: 0 });
      await server('if data block 0 240 2 {primary_effect:"minecraft:speed"}', "Server beacon retained actual selected speed");
      await server('if data entity @p active_effects[{id:"minecraft:speed"}]', "Server player received actual selected beacon speed effect");
      requireProof(await ctx.maybeRead() === null, "Beacon consequence assertion unexpectedly reopened a screen");
    }
  } finally { entry.custom_effects = ctx.effects.slice(effectStart); }
}
