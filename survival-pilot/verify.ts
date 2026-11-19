import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const SHORE_POURS = 8;
const FRAME_BLOCKS = 10;
// Allow one extra placement beyond the compact plan's nine support blocks.
const MAX_DIAGNOSTIC_SUPPORTS = 10;
const blockPosition = z.tuple([z.int(), z.int(), z.int()]);
const progressSchema = z.object({
    goal: z.string(), won: z.literal(true), alive: z.literal(true),
    inventory: z.record(z.string(), z.number().int().nonnegative()),
    dimension: z.string().optional(), frame_blocks: z.int().optional(), ignited: z.boolean().optional(),
    cast_method: z.literal("shore").optional(),
    cast_frame_blocks: z.int().optional(),
    cast_passive_blocks: z.int().optional(),
    cast_lava_deposits: z.int().optional(),
    cast_passive_cells: z.array(blockPosition).optional(),
    cast_poured_cells: z.array(blockPosition).optional(),
});
const statsSchema = z.object({ stats: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())) });

function hasCompleteShoreCast(progress: z.infer<typeof progressSchema>) {
    const { cast_passive_cells: passive, cast_poured_cells: poured } = progress;
    if (progress.cast_method !== "shore" || progress.cast_frame_blocks !== FRAME_BLOCKS ||
        progress.cast_passive_blocks !== 2 || progress.cast_lava_deposits !== SHORE_POURS ||
        passive?.length !== 2 || poured?.length !== SHORE_POURS) return false;

    const [x, y, z] = passive[0]!;
    const [otherX, otherY, otherZ] = passive[1]!;
    const dx = (otherX - x) / 3, dz = (otherZ - z) / 3;
    if (y !== otherY || !Number.isInteger(dx) || !Number.isInteger(dz) || Math.abs(dx) + Math.abs(dz) !== 1)
        return false;

    // The passive cells are the feet. The eight pours fill the remaining cornerless frame.
    const observed = new Set(poured.map(cell => cell.join(",")));
    const has = (across: number, up: number) => observed.has(`${x + across * dx},${y + up},${z + across * dz}`);
    return has(1, -1) && has(2, -1) && has(0, 1) && has(3, 1) &&
        has(0, 2) && has(3, 2) && has(1, 3) && has(2, 3);
}

/** Use only after the server has saved and closed the fresh world. Never supply this
 * data to the actor. A client-predicted craft and a timed-out pickup are not wins. */
export async function verifySurvival(statsDirectory: string, goal: string, progress: unknown, requireCast = false) {
    let mined = 0, crafted = 0, pickedUp = 0;
    let shoreCast = false;
    const result = (verified: boolean, reason: string) => ({ verified, reason, mined, crafted, pickedUp });
    const p = progressSchema.safeParse(progress);
    if (!p.success || p.data.goal !== goal) return result(false, "Missing live player victory");
    if (goal === "nether_portal") {
        if (p.data.dimension !== "minecraft:the_nether" || p.data.frame_blocks !== FRAME_BLOCKS || !p.data.ignited)
            return result(false, "No observed construction, ignition and Nether arrival");
        shoreCast = hasCompleteShoreCast(p.data);
        if ((requireCast || p.data.cast_method === "shore") && !shoreCast)
            return result(false, "Missing completed shore cast with two passive feet and eight poured frame cells");
    } else if (!(p.data.inventory[`minecraft:${goal}`]! > 0))
        return result(false, "Live player did not retain the declared item");
    if (!["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal"].includes(goal))
        return result(false, "Unsupported proof");
    try {
        const files = (await readdir(statsDirectory, { withFileTypes: true })).filter(e => e.isFile() &&
            /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(e.name));
        if (files.length !== 1) return result(false, "Expected one saved player in this new world");
        const { stats } = statsSchema.parse(JSON.parse(await readFile(path.join(statsDirectory, files[0]!.name), "utf8")));
        const count = (key: string, item: string) => stats[`minecraft:${key}`]?.[`minecraft:${item}`] ?? 0;
        mined = count("mined", "diamond_ore") + count("mined", "deepslate_diamond_ore");
        if (goal === "nether_portal") {
            const advancements = JSON.parse(await readFile(path.join(statsDirectory, "../advancements", files[0]!.name), "utf8"));
            const placed = count("used", "obsidian"), fires = count("used", "flint_and_steel");
            const lavaBuckets = count("used", "lava_bucket"), waterBuckets = count("used", "water_bucket");
            const cast = shoreCast && lavaBuckets >= SHORE_POURS && waterBuckets > 0;
            const nether = advancements?.["minecraft:story/enter_the_nether"];
            const criterion = nether?.criteria?.entered_nether;
            const entered = nether?.done === true && typeof criterion === "string" && criterion.length > 0;
            const supports = count("used", "cobblestone") + count("used", "cobbled_deepslate") + count("used", "dirt");
            const diamondPickaxeActions = count("used", "diamond_pickaxe") +
                count("broken", "diamond_pickaxe") + count("crafted", "diamond_pickaxe");
            const diagnosticBuild = placed === 0 && count("mined", "obsidian") === 0 &&
                diamondPickaxeActions === 0 && supports <= MAX_DIAGNOSTIC_SUPPORTS;
            const frame = shoreCast ? cast && (!requireCast || diagnosticBuild) : placed >= FRAME_BLOCKS;
            const verified = frame && fires > 0 && entered;
            return { ...result(verified, verified
                ? `Vanilla ${cast ? "bucket casting" : "obsidian use"}, ignition and Nether advancement corroborate entry`
                : "Saved statistics do not corroborate portal construction and traversal"),
                placed, lavaBuckets, waterBuckets, cast, fires, entered, supports };
        }
        crafted = count("crafted", goal);
        pickedUp = count("picked_up", goal);
        const verified = goal === "diamond" ? mined > 0 && pickedUp > 0 : crafted > 0;
        return result(verified, verified ? "Vanilla player statistics corroborate the live inventory" :
            "Saved player statistics do not corroborate the claimed goal");
    } catch { return result(false, "Saved player statistics unavailable or unreadable"); }
}
