import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const progressSchema = z.object({
    goal: z.string(), won: z.literal(true), alive: z.literal(true),
    inventory: z.record(z.string(), z.number().int().nonnegative()),
});
const statsSchema = z.object({ stats: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())) });

/** Use only after the server has saved and closed the fresh world. Never supply this
 * data to the actor. A client-predicted craft and a timed-out pickup are not wins. */
export async function verifySurvival(statsDirectory: string, goal: string, progress: unknown) {
    let mined = 0, crafted = 0, pickedUp = 0;
    const result = (verified: boolean, reason: string) => ({ verified, reason, mined, crafted, pickedUp });
    const p = progressSchema.safeParse(progress);
    if (!p.success || p.data.goal !== goal || !(p.data.inventory[`minecraft:${goal}`]! > 0))
        return result(false, "Live player did not retain the declared item");
    if (!["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond"].includes(goal))
        return result(false, "Unsupported proof");
    try {
        const files = (await readdir(statsDirectory, { withFileTypes: true })).filter(e => e.isFile() &&
            /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(e.name));
        if (files.length !== 1) return result(false, "Expected one saved player in this new world");
        const { stats } = statsSchema.parse(JSON.parse(await readFile(path.join(statsDirectory, files[0]!.name), "utf8")));
        const count = (key: string, item: string) => stats[`minecraft:${key}`]?.[`minecraft:${item}`] ?? 0;
        mined = count("mined", "diamond_ore") + count("mined", "deepslate_diamond_ore");
        crafted = count("crafted", goal);
        pickedUp = count("picked_up", goal);
        const verified = goal === "diamond" ? mined > 0 && pickedUp > 0 : crafted > 0;
        return result(verified, verified ? "Vanilla player statistics corroborate the live inventory" :
            "Saved player statistics do not corroborate the claimed goal");
    } catch { return result(false, "Saved player statistics unavailable or unreadable"); }
}
