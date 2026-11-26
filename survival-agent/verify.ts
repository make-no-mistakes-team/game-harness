import { constants } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MacroStatus } from "../src/server/survival-macro/controller.ts";

const SHORE_POURS = 8;
const FRAME_BLOCKS = 10;
// Allow one extra placement beyond the compact plan's nine support blocks.
const MAX_DIAGNOSTIC_SUPPORTS = 10;
const blockPosition = z.tuple([z.int(), z.int(), z.int()]);
const progressSchema = z.object({
    goal: z.string(), won: z.boolean(), alive: z.literal(true),
    tick: z.int().nonnegative().optional(), life: z.int().positive().optional(),
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
type SavedPlayerStats = z.infer<typeof statsSchema> & { file: string; netherCriterion: string | null };

export type ProgramWin = { run: string; program: NonNullable<MacroStatus["completedWorkProgram"]> };

export type MinedObsidianBaseline = {
    diamondOre: number; deepslateDiamondOre: number; diamondsPickedUp: number;
    obsidianMined: number; obsidianPickedUp: number; obsidianPlaced: number;
};
/** Host-validated material sequence: fresh-world zero, or the admitted assisted anchor's saved counters.
 * An assisted sequence never becomes an unassisted campaign/benchmark claim. */
export type MinedObsidianCampaign = {
    rootRun: string; playerFile: string; scope: "fresh-world" | "assisted-sequence";
    baseline: MinedObsidianBaseline;
};
export type PortalRequirements = {
    requireMinedObsidian?: boolean;
    campaign?: MinedObsidianCampaign;
};

/** Supplied only by the admitted host, never by the model or the progress file. */
export function retainsCompletedProgram({ run, program }: ProgramWin, goal: string, player: {
    goal: string; alive: boolean; tick?: number; life?: number; inventory?: Record<string, number>;
    dimension?: string; frame_blocks?: number; ignited?: boolean;
}) {
    const { basis, finalOrder, accepted, receipt, stock } = program;
    const inventory = player.inventory;
    if (!inventory || !player.alive || player.goal !== goal || program.goal !== goal ||
        !program.requestId || program.stages < 1 || player.tick === undefined || player.tick < basis.tick ||
        finalOrder.origin !== "model" || basis.run !== run || finalOrder.run !== run ||
        accepted.run !== run || receipt.run !== run || basis.life !== player.life ||
        finalOrder.life !== basis.life || accepted.life !== basis.life || receipt.life !== basis.life ||
        accepted.id !== finalOrder.id || receipt.id !== finalOrder.id || accepted.status !== "accepted" ||
        receipt.status !== "completed" || accepted.tick < finalOrder.basisTick || receipt.tick < accepted.tick ||
        receipt.tick > finalOrder.expiresTick || basis.tick < receipt.tick) return false;
    if (stock.some(s => s.observed < s.required || (inventory[s.item] ?? 0) < s.required) ||
        finalOrder.reserves.some(s => (inventory[s.item] ?? 0) < s.count)) return false;
    const target = finalOrder.target;
    if (target.kind === "stock" ? (inventory[target.item] ?? 0) < target.count : target.goal !== goal) return false;
    return goal === "nether_portal" ? target.kind === "preset" && player.dimension === "minecraft:the_nether" &&
        player.frame_blocks === FRAME_BLOCKS && player.ignited === true :
        (program.invocationItemCount ?? 0) > 0 && (inventory[`minecraft:${goal}`] ?? 0) > 0;
}

function absent(error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readSavedJson(file: string) {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || entry.size > 4_000_000) {
        throw new Error("Expected an owned vanilla player receipt.");
    }
    return JSON.parse(await readFile(file, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
}

/** Read only in a copied world before launch or after the owned server has saved and closed. */
export async function readSavedPlayerStats(directory: string): Promise<SavedPlayerStats | null> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (absent(error)) return [];
        throw error;
    });
    const files = entries.filter(entry => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(entry.name));
    if (!files.length) return null;
    if (files.length !== 1 || !files[0]!.isFile()) throw new Error("Expected one saved vanilla player.");
    const file = files[0]!.name;
    const saved = statsSchema.parse(await readSavedJson(path.join(directory, file)));
    const advancements = await readSavedJson(path.join(directory, "../advancements", file)).catch(error => {
        if (absent(error)) return null;
        throw error;
    });
    const nether = advancements?.["minecraft:story/enter_the_nether"];
    const criterion = nether?.criteria?.entered_nether;
    const netherCriterion = nether?.done === true && typeof criterion === "string" && criterion.length > 0
        ? criterion : null;
    return { ...saved, file, netherCriterion };
}

function count(saved: SavedPlayerStats | null, key: string, item: string) {
    return saved?.stats[`minecraft:${key}`]?.[`minecraft:${item}`] ?? 0;
}

export function savedDeathDelta(before: SavedPlayerStats | null, after: SavedPlayerStats | null) {
    if (!after || before && before.file !== after.file) return null;
    const initial = count(before, "custom", "deaths");
    const final = count(after, "custom", "deaths");
    return final < initial ? null : { before: initial, after: final, attempt: final - initial };
}

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

/** Use only after the server has saved and closed the world. Never supply this
 * data to the actor. A client-predicted craft and a timed-out pickup are not wins. */
export async function verifySurvival(statsDirectory: string, goal: string, progress: unknown, requireCast = false,
        before: SavedPlayerStats | null = null, programWin: ProgramWin | null = null,
        { requireMinedObsidian = false, campaign }: PortalRequirements = {}) {
    let mined = 0, crafted = 0, pickedUp = 0;
    let shoreCast = false;
    const result = (verified: boolean, reason: string) => ({ verified, reason, mined, crafted, pickedUp });
    if (requireMinedObsidian && (goal !== "nether_portal" || requireCast))
        return result(false, "Mined obsidian requires the ordinary nether_portal goal, not a casting diagnostic");
    if (requireMinedObsidian && (!campaign?.rootRun || !campaign.playerFile || !campaign.baseline ||
        !["fresh-world", "assisted-sequence"].includes(campaign.scope) ||
        !["diamondOre", "deepslateDiamondOre", "diamondsPickedUp", "obsidianMined", "obsidianPickedUp", "obsidianPlaced"]
            .every(key => Number.isSafeInteger(campaign.baseline[key as keyof MinedObsidianBaseline]) &&
                campaign.baseline[key as keyof MinedObsidianBaseline] >= 0)))
        return result(false, "Missing host-validated mining-sequence baseline and own-player identity");
    const p = progressSchema.safeParse(progress);
    if (!p.success || p.data.goal !== goal ||
        (programWin ? requireCast || !retainsCompletedProgram(programWin, goal, p.data) : !p.data.won))
        return result(false, "Missing live player victory");
    if (goal === "nether_portal") {
        if (p.data.dimension !== "minecraft:the_nether" || p.data.frame_blocks !== FRAME_BLOCKS || !p.data.ignited)
            return result(false, "No observed construction, ignition and Nether arrival");
        shoreCast = hasCompleteShoreCast(p.data);
        if (requireMinedObsidian && p.data.cast_method === "shore")
            return result(false, "Mined-obsidian construction cannot use a shore-cast frame");
        if ((requireCast || p.data.cast_method === "shore") && !shoreCast)
            return result(false, "Missing completed shore cast with two passive feet and eight poured frame cells");
    } else if (!(p.data.inventory[`minecraft:${goal}`]! > 0))
        return result(false, "Live player did not retain the declared item");
    if (!["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "diamond_pickaxe", "nether_portal"].includes(goal))
        return result(false, "Unsupported proof");
    try {
        const saved = await readSavedPlayerStats(statsDirectory);
        if (!saved) return result(false, "Expected one saved player in this world");
        if (before && saved.file !== before.file) return result(false, "Saved player changed during the continuation");
        if (requireMinedObsidian && saved.file !== campaign!.playerFile)
            return result(false, "Saved statistics do not belong to the campaign's authenticated player");
        const total = (key: string, item: string) => count(saved, key, item);
        const delta = (key: string, item: string) => {
            const change = total(key, item) - count(before, key, item);
            if (change < 0) throw new Error("Saved player statistics decreased.");
            return change;
        };
        mined = delta("mined", "diamond_ore") + delta("mined", "deepslate_diamond_ore");
        if (goal === "nether_portal") {
            const placed = total("used", "obsidian"), fires = total("used", "flint_and_steel");
            const lavaBuckets = total("used", "lava_bucket"), waterBuckets = total("used", "water_bucket");
            const cast = shoreCast && lavaBuckets >= SHORE_POURS && waterBuckets > 0;
            const entered = saved.netherCriterion !== null;
            const newIgnition = delta("used", "flint_and_steel") > 0;
            const firstEntry = entered && (before?.netherCriterion ?? null) === null;
            const supports = total("used", "cobblestone") + total("used", "cobbled_deepslate") + total("used", "dirt");
            const diamondPickaxeActions = total("used", "diamond_pickaxe") +
                total("broken", "diamond_pickaxe") + total("crafted", "diamond_pickaxe");
            const diagnosticBuild = placed === 0 && total("mined", "obsidian") === 0 &&
                diamondPickaxeActions === 0 && supports <= MAX_DIAGNOSTIC_SUPPORTS;
            const frame = shoreCast ? cast && (!requireCast || diagnosticBuild) : placed >= FRAME_BLOCKS;
            if (requireMinedObsidian) {
                // The sequence baseline is NOT the current portal attempt's baseline:
                // diamonds earned by earlier in-scope diamond runs still count after crafting.
                const baseline = campaign!.baseline;
                const sequenceDelta = (key: string, item: string, initial: number) => {
                    const change = total(key, item) - initial;
                    if (change < 0) throw new Error("Mining-sequence statistics decreased below its baseline.");
                    return change;
                };
                const diamondsMined = sequenceDelta("mined", "diamond_ore", baseline.diamondOre) +
                    sequenceDelta("mined", "deepslate_diamond_ore", baseline.deepslateDiamondOre);
                const diamondsPickedUp = sequenceDelta("picked_up", "diamond", baseline.diamondsPickedUp);
                const obsidianMined = sequenceDelta("mined", "obsidian", baseline.obsidianMined);
                const obsidianPickedUp = sequenceDelta("picked_up", "obsidian", baseline.obsidianPickedUp);
                const obsidianPlaced = sequenceDelta("used", "obsidian", baseline.obsidianPlaced);
                for (const [key, item] of [
                    ["mined", "diamond_ore"], ["mined", "deepslate_diamond_ore"], ["picked_up", "diamond"],
                    ["mined", "obsidian"], ["picked_up", "obsidian"], ["used", "obsidian"],
                ] as const) delta(key, item);
                const materials = obsidianMined >= FRAME_BLOCKS && obsidianPickedUp >= FRAME_BLOCKS;
                const verified = materials && obsidianPlaced >= FRAME_BLOCKS && frame &&
                    fires > 0 && entered && (newIgnition || firstEntry);
                return { ...result(verified, verified
                    ? "Own-player sequence mining and pickup of ten obsidian, placed frame, ignition and Nether arrival corroborate entry"
                    : "Missing sequence mining and pickup of ten obsidian, placed frame, or new Nether entry"),
                    requireMinedObsidian, campaign, diamondsMined, diamondsPickedUp, obsidianMined, obsidianPickedUp, obsidianPlaced,
                    placed, lavaBuckets, waterBuckets, cast, fires, entered, supports, newIgnition, firstEntry };
            }
            const verified = frame && fires > 0 && entered && (newIgnition || firstEntry);
            return { ...result(verified, verified
                ? `Vanilla ${cast ? "bucket casting" : "obsidian use"}, ignition and Nether advancement corroborate entry`
                : "Saved statistics do not corroborate portal construction and new ignition or Nether entry"),
                placed, lavaBuckets, waterBuckets, cast, fires, entered, supports, newIgnition, firstEntry };
        }
        crafted = delta("crafted", goal);
        pickedUp = delta("picked_up", goal);
        const diamondsPicked = delta("picked_up", "diamond");
        const verified = goal === "diamond" ? mined > 0 && pickedUp > 0
            : goal === "diamond_pickaxe" ? crafted > 0 && mined >= 3 && diamondsPicked >= 3
            : crafted > 0;
        return result(verified, verified ? "This attempt's vanilla player statistics corroborate the live inventory" :
            "Saved player statistics do not corroborate a newly achieved goal");
    } catch { return result(false, "Saved player statistics unavailable or unreadable"); }
}
