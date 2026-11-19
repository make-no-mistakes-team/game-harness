import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedPlayerStats, savedDeathDelta, verifySurvival } from "../survival-agent/verify.ts";

const goal = "nether_portal";
const player = "127d3ae0-4132-4aac-804e-54528afce41b.json";
const livePortal = {
    goal, won: true, alive: true, ignited: true, dimension: "minecraft:the_nether",
    inventory: { "minecraft:water_bucket": 1 }, frame_blocks: 10,
};
const liveShore = {
    ...livePortal, cast_method: "shore", cast_frame_blocks: 10, cast_passive_blocks: 2, cast_lava_deposits: 8,
    cast_passive_cells: [[3, 64, 9], [0, 64, 9]],
    cast_poured_cells: [
        [1, 63, 9], [2, 63, 9], [0, 65, 9], [3, 65, 9],
        [0, 66, 9], [3, 66, 9], [1, 67, 9], [2, 67, 9],
    ],
};
const shoreUse = {
    "minecraft:lava_bucket": 8, "minecraft:water_bucket": 3,
    "minecraft:flint_and_steel": 1, "minecraft:cobblestone": 9,
};
const netherAdvancement = { criteria: { entered_nether: "2026-11-19 12:00:00 +0000" }, done: true };
const worlds: string[] = [];
afterEach(async () => {
    for (const world of worlds.splice(0)) await rm(world, { recursive: true, force: true });
});

async function saveWorld(stats: Record<string, Record<string, number>>,
    advancement: { criteria: Record<string, string>; done: boolean } = netherAdvancement) {
    const root = await mkdtemp(join(tmpdir(), "survival-agent-verify-"));
    worlds.push(root);
    const savedStats = join(root, "stats");
    const advancements = join(root, "advancements");
    await mkdir(savedStats);
    await mkdir(advancements);
    await writeFile(join(savedStats, player), JSON.stringify({ DataVersion: 4189, stats }));
    await writeFile(join(advancements, player), JSON.stringify({
        DataVersion: 4189,
        "minecraft:story/enter_the_nether": advancement,
    }));
    return savedStats;
}

test("the supplied kit verifies ten compact frame cells with only eight saved lava bucket uses", async () => {
    const stats = await saveWorld({ "minecraft:used": shoreUse });
    expect(await verifySurvival(stats, goal, liveShore, true)).toMatchObject({
        verified: true, cast: true, lavaBuckets: 8, entered: true,
    });
});

test.each([
    ["no completed method", { cast_method: undefined }],
    ["nine observed frame blocks", { frame_blocks: 9 }],
    ["one passive receipt", { cast_passive_blocks: 1 }],
    ["one passive cell", { cast_passive_cells: [[3, 64, 9]] }],
    ["duplicate passive feet", { cast_passive_cells: [[3, 64, 9], [3, 64, 9]] }],
    ["seven pour receipts", { cast_lava_deposits: 7 }],
    ["seven poured cells", { cast_poured_cells: liveShore.cast_poured_cells.slice(1) }],
    ["duplicate pour", { cast_poured_cells: [...liveShore.cast_poured_cells.slice(1), [2, 63, 9]] }],
    ["one cell serving as both passive and poured", {
        cast_poured_cells: [...liveShore.cast_poured_cells.slice(1), [3, 64, 9]],
    }],
    ["a pour outside the frame", { cast_poured_cells: [...liveShore.cast_poured_cells.slice(1), [1, 63, 10]] }],
    ["no live ignition", { ignited: false }],
    ["no live Nether arrival", { dimension: "minecraft:overworld" }],
] as const)("saved stats do not replace live compact proof: %s", async (_description, changed) => {
    const stats = await saveWorld({ "minecraft:used": shoreUse });
    expect((await verifySurvival(stats, goal, { ...liveShore, ...changed }, true)).verified).toBe(false);
});

test.each([
    ["minecraft:lava_bucket", 7],
    ["minecraft:water_bucket", 0],
    ["minecraft:flint_and_steel", 0],
] as const)("live compact proof does not replace saved %s use", async (item, count) => {
    const stats = await saveWorld({ "minecraft:used": { ...shoreUse, [item]: count } });
    expect((await verifySurvival(stats, goal, liveShore, true)).verified).toBe(false);
});

test.each([
    ["no criterion", { criteria: {}, done: true }],
    ["not done", { ...netherAdvancement, done: false }],
] as const)("compact casting requires the saved Nether advancement: %s", async (_description, advancement) => {
    const stats = await saveWorld({ "minecraft:used": shoreUse }, advancement);
    expect(await verifySurvival(stats, goal, liveShore, true)).toMatchObject({ verified: false, entered: false });
});

test.each([
    ["minecraft:used", "minecraft:obsidian", 1],
    ["minecraft:mined", "minecraft:obsidian", 1],
    ["minecraft:used", "minecraft:diamond_pickaxe", 1],
    ["minecraft:broken", "minecraft:diamond_pickaxe", 1],
    ["minecraft:crafted", "minecraft:diamond_pickaxe", 1],
    ["minecraft:used", "minecraft:dirt", 2],
] as const)("the supplied kit rejects these extra saved actions: %s %s", async (category, item, count) => {
    const saved: Record<string, Record<string, number>> = { "minecraft:used": shoreUse };
    saved[category] = { ...saved[category], [item]: count };
    const stats = await saveWorld(saved);
    expect((await verifySurvival(stats, goal, liveShore, true)).verified).toBe(false);
});

test.each([8, 10])("ordinary verification cannot credit %s lava bucket uses alone", async lava => {
    const stats = await saveWorld({ "minecraft:used": { ...shoreUse, "minecraft:lava_bucket": lava } });
    expect((await verifySurvival(stats, goal, { ...liveShore, cast_method: undefined })).verified).toBe(false);
});

test("saved obsidian placement remains an ordinary-only path", async () => {
    const stats = await saveWorld({ "minecraft:used": { "minecraft:obsidian": 10, "minecraft:flint_and_steel": 1 } });
    expect(await verifySurvival(stats, goal, livePortal)).toMatchObject({ verified: true, cast: false });
    expect((await verifySurvival(stats, goal, livePortal, true)).verified).toBe(false);
});

test("continuation credits new mining and pickup, not an inherited diamond or lifetime death count", async () => {
    const diamond = { goal: "diamond", won: true, alive: true, inventory: { "minecraft:diamond": 1 } };
    const initial = {
        "minecraft:mined": { "minecraft:diamond_ore": 2 },
        "minecraft:picked_up": { "minecraft:diamond": 2 },
        "minecraft:custom": { "minecraft:deaths": 4 },
    };
    const stats = await saveWorld(initial);
    const before = await readSavedPlayerStats(stats);
    expect((await verifySurvival(stats, "diamond", diamond, false, before)).verified).toBe(false);
    await writeFile(join(stats, player), JSON.stringify({ stats: {
        ...initial, "minecraft:picked_up": { "minecraft:diamond": 3 },
    } }));
    expect((await verifySurvival(stats, "diamond", diamond, false, before)).verified).toBe(false);
    await writeFile(join(stats, player), JSON.stringify({ stats: {
        "minecraft:mined": { "minecraft:diamond_ore": 3 },
        "minecraft:picked_up": { "minecraft:diamond": 3 },
        "minecraft:custom": { "minecraft:deaths": 5 },
    } }));
    expect(await verifySurvival(stats, "diamond", diamond, false, before)).toMatchObject({
        verified: true, mined: 1, pickedUp: 1,
    });
    expect(savedDeathDelta(before, await readSavedPlayerStats(stats))).toEqual({
        before: 4, after: 5, attempt: 1,
    });
});

test("a continuation may enter the Nether for the first time through its earlier build, but lifetime proof alone is not enough",
    async () => {
        const use = { "minecraft:used": { "minecraft:obsidian": 10, "minecraft:flint_and_steel": 1 } };
        const stats = await saveWorld(use, { criteria: {}, done: false });
        const notYetEntered = await readSavedPlayerStats(stats);
        await writeFile(join(stats, "..", "advancements", player), JSON.stringify({
            "minecraft:story/enter_the_nether": netherAdvancement,
        }));
        expect((await verifySurvival(stats, goal, livePortal, false, notYetEntered)).verified).toBe(true);
        const inherited = await readSavedPlayerStats(stats);
        expect((await verifySurvival(stats, goal, livePortal, false, inherited)).verified).toBe(false);
    });
