import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedPlayerStats, savedDeathDelta, verifySurvival, type ProgramWin } from "../survival-agent/verify.ts";

const goal = "nether_portal";
const player = "127d3ae0-4132-4aac-804e-54528afce41b.json";
const minedPortal = {
    requireMinedObsidian: true,
    campaign: { rootRun: "fresh-survival-root", playerFile: player, scope: "fresh-world" as const,
        baseline: { diamondOre: 0, deepslateDiamondOre: 0, diamondsPickedUp: 0,
            obsidianMined: 0, obsidianPickedUp: 0, obsidianPlaced: 0 } },
};
const minedPortalStats = {
    "minecraft:mined": {
        "minecraft:diamond_ore": 1, "minecraft:deepslate_diamond_ore": 2, "minecraft:obsidian": 10,
    },
    "minecraft:picked_up": { "minecraft:diamond": 3, "minecraft:obsidian": 10 },
    "minecraft:used": { "minecraft:obsidian": 10, "minecraft:flint_and_steel": 1 },
};
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

test("diamond pickaxe continuation credits prior diamonds but requires a new craft", async () => {
    const initial = {
        "minecraft:mined": { "minecraft:diamond_ore": 1, "minecraft:deepslate_diamond_ore": 2 },
        "minecraft:picked_up": { "minecraft:diamond": 3 },
    };
    const stats = await saveWorld(initial);
    const before = await readSavedPlayerStats(stats);
    const progress = { goal: "diamond_pickaxe", alive: true, won: true,
        inventory: { "minecraft:diamond_pickaxe": 1 } };
    expect((await verifySurvival(stats, "diamond_pickaxe", progress, false, before)).verified).toBe(false);
    await writeFile(join(stats, player), JSON.stringify({ stats: {
        ...initial, "minecraft:crafted": { "minecraft:diamond_pickaxe": 1 },
    } }));
    expect(await verifySurvival(stats, "diamond_pickaxe", progress, false, before)).toMatchObject({
        verified: true, mined: 0, crafted: 1,
    });
    const crafted = await readSavedPlayerStats(stats);
    expect((await verifySurvival(stats, "diamond_pickaxe", progress, false, crafted)).verified).toBe(false);
    const noMining = await saveWorld({ "minecraft:crafted": { "minecraft:diamond_pickaxe": 1 } });
    expect((await verifySurvival(noMining, "diamond_pickaxe", progress)).verified).toBe(false);
    expect((await verifySurvival(noMining, "diamond_pickaxe", progress, false, before)).verified).toBe(false);
});
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

test("constrained success requires both the finished program and a newly achieved vanilla goal in the same life", async () => {
    const goal = "wooden_pickaxe", pick = "minecraft:wooden_pickaxe", log = "minecraft:birch_log";
    const stats = await saveWorld({ "minecraft:crafted": { [pick]: 1 } });
    const run = "ordinary", id = "last-order", life = 2;
    const accepted = { v: 1, run, id, life, tick: 21, status: "accepted", detail: "admitted" } as const;
    const witness: ProgramWin = { run, program: {
        requestId: "plan-request", stages: 2, goal, invocationItemCount: 1,
        basis: { run, life, epoch: 4, tick: 35 }, stock: [{ item: log, required: 1, observed: 1 }],
        accepted, receipt: { ...accepted, tick: 34, status: "completed" },
        finalOrder: { v: 1, run, id, life, epoch: 3, safetyRevision: 1, origin: "model",
            basisTick: 20, expiresTick: 90, target: { kind: "preset", goal }, reserves: [{ item: log, count: 1 }],
            allowedEffects: ["craft:wooden_pickaxe"], costCaps: [], maxBreaks: 0, maxCrafts: 1, maxPlacements: 0 },
    } };
    const p = { goal, tick: 36, life, alive: true, won: false, inventory: { [pick]: 1, [log]: 1 } };
    expect((await verifySurvival(stats, goal, p, false, null, witness)).verified).toBe(true);
    expect((await verifySurvival(stats, goal, p)).verified).toBe(false);
    for (const invalid of [{ ...p, tick: 33 }, { ...p, life: 3 }, { ...p, inventory: { [pick]: 1 } }]) {
        expect((await verifySurvival(stats, goal, invalid, false, null, witness)).verified).toBe(false);
    }
    for (const invalid of [
        { ...witness, run: "other-run" },
        { ...witness, program: { ...witness.program, invocationItemCount: 0 } },
        { ...witness, program: { ...witness.program, receipt: { ...witness.program.receipt, id: "different" } } },
    ]) {
        expect((await verifySurvival(stats, goal, p, false, null, invalid)).verified).toBe(false);
    }
    const oldStats = await readSavedPlayerStats(stats);
    expect((await verifySurvival(stats, goal, p, false, oldStats, witness)).verified).toBe(false);
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

test("strict portal verification rejects casting even when campaign mining counters are sufficient", async () => {
    const stats = await saveWorld({
        ...minedPortalStats, "minecraft:used": { ...minedPortalStats["minecraft:used"], ...shoreUse },
    });
    expect((await verifySurvival(stats, goal, liveShore)).verified).toBe(true);
    expect(await verifySurvival(stats, goal, liveShore, false, null, null, minedPortal)).toMatchObject({
        verified: false, reason: expect.stringContaining("shore-cast"),
    });
    expect((await verifySurvival(stats, goal, livePortal, true, null, null, minedPortal)).verified).toBe(false);
});

test("strict portal verification rejects placed-only obsidian without changing ordinary verification", async () => {
    const stats = await saveWorld({ "minecraft:used": minedPortalStats["minecraft:used"] });
    expect((await verifySurvival(stats, goal, livePortal)).verified).toBe(true);
    expect(await verifySurvival(stats, goal, livePortal, false, null, null, minedPortal)).toMatchObject({
        verified: false, obsidianMined: 0, obsidianPickedUp: 0, diamondsMined: 0, diamondsPickedUp: 0,
    });
});

test.each([
    ["minecraft:mined", "minecraft:obsidian", 9],
    ["minecraft:picked_up", "minecraft:obsidian", 9],
    ["minecraft:used", "minecraft:obsidian", 9],
    ["minecraft:used", "minecraft:flint_and_steel", 0],
] as const)("strict portal requires sufficient own-player %s %s", async (category, item, count) => {
    const stats = await saveWorld({
        ...minedPortalStats, [category]: { ...minedPortalStats[category], [item]: count },
    });
    expect((await verifySurvival(stats, goal, livePortal, false, null, null, minedPortal)).verified).toBe(false);
});

test("strict portal requires obsidian pickup, not breaks or final construction alone", async () => {
    const stats = await saveWorld({ ...minedPortalStats, "minecraft:picked_up": { "minecraft:diamond": 3 } });
    expect((await verifySurvival(stats, goal, livePortal, false, null, null, minedPortal)).verified).toBe(false);
});

test("strict obsidian proof permits traded picks and Fortune rather than requiring three diamond-ore breaks", async () => {
    for (const diamondOre of [0, 1]) {
        const stats = await saveWorld({
            "minecraft:mined": { "minecraft:diamond_ore": diamondOre, "minecraft:obsidian": 10 },
            "minecraft:picked_up": { "minecraft:obsidian": 10 },
            "minecraft:used": minedPortalStats["minecraft:used"],
        });
        expect(await verifySurvival(stats, goal, livePortal, false, null, null, minedPortal)).toMatchObject({
            verified: true, diamondsMined: diamondOre, diamondsPickedUp: 0,
            obsidianMined: 10, obsidianPickedUp: 10,
        });
    }
});

test("assisted obsidian sequence subtracts its actual anchor and never credits pre-anchor materials", async () => {
    const requirement = { requireMinedObsidian: true, campaign: {
        ...minedPortal.campaign, rootRun: "admitted-assisted-anchor", scope: "assisted-sequence" as const,
        baseline: { diamondOre: 4, deepslateDiamondOre: 2, diamondsPickedUp: 8,
            obsidianMined: 7, obsidianPickedUp: 7, obsidianPlaced: 5 },
    } };
    const stats = await saveWorld({
        "minecraft:mined": { "minecraft:diamond_ore": 4, "minecraft:deepslate_diamond_ore": 2, "minecraft:obsidian": 16 },
        "minecraft:picked_up": { "minecraft:diamond": 8, "minecraft:obsidian": 16 },
        "minecraft:used": { "minecraft:obsidian": 15, "minecraft:flint_and_steel": 1 },
    });
    expect(await verifySurvival(stats, goal, livePortal, false, null, null, requirement)).toMatchObject({
        verified: false, obsidianMined: 9, obsidianPickedUp: 9, obsidianPlaced: 10,
    });
    await writeFile(join(stats, player), JSON.stringify({ stats: {
        "minecraft:mined": { "minecraft:diamond_ore": 4, "minecraft:deepslate_diamond_ore": 2, "minecraft:obsidian": 17 },
        "minecraft:picked_up": { "minecraft:diamond": 8, "minecraft:obsidian": 17 },
        "minecraft:used": { "minecraft:obsidian": 15, "minecraft:flint_and_steel": 1 },
    } }));
    expect(await verifySurvival(stats, goal, livePortal, false, null, null, requirement)).toMatchObject({
        verified: true, diamondsMined: 0, diamondsPickedUp: 0,
        obsidianMined: 10, obsidianPickedUp: 10, obsidianPlaced: 10,
        campaign: { rootRun: "admitted-assisted-anchor", scope: "assisted-sequence" },
    });
});

test("strict continuation credits prior campaign diamonds after they were spent on the pickaxe", async () => {
    const initial = {
        "minecraft:mined": { "minecraft:diamond_ore": 1, "minecraft:deepslate_diamond_ore": 2 },
        "minecraft:picked_up": { "minecraft:diamond": 3 },
        "minecraft:crafted": { "minecraft:diamond_pickaxe": 1 },
    };
    const stats = await saveWorld(initial, { criteria: {}, done: false });
    const before = await readSavedPlayerStats(stats);
    await writeFile(join(stats, player), JSON.stringify({ stats: {
        ...minedPortalStats, "minecraft:crafted": initial["minecraft:crafted"],
    } }));
    await writeFile(join(stats, "..", "advancements", player), JSON.stringify({
        "minecraft:story/enter_the_nether": netherAdvancement,
    }));
    expect(await verifySurvival(stats, goal, livePortal, false, before, null, minedPortal)).toMatchObject({
        verified: true, mined: 0, diamondsMined: 3, diamondsPickedUp: 3,
        obsidianMined: 10, obsidianPickedUp: 10, placed: 10, cast: false, firstEntry: true,
        campaign: minedPortal.campaign,
    });
});

test("strict proof rejects missing campaign scope and another player's statistics", async () => {
    const stats = await saveWorld(minedPortalStats);
    expect((await verifySurvival(stats, goal, livePortal, false, null, null,
        { requireMinedObsidian: true })).verified).toBe(false);
    expect((await verifySurvival(stats, goal, livePortal, false, null, null, {
        ...minedPortal, campaign: { ...minedPortal.campaign, playerFile: "other-player.json" },
    })).verified).toBe(false);
});

test("strict campaign proof still requires live arrival, saved advancement and a new entry or ignition", async () => {
    const stats = await saveWorld(minedPortalStats);
    for (const changed of [{ dimension: "minecraft:overworld" }, { frame_blocks: 9 }, { ignited: false }]) {
        expect((await verifySurvival(stats, goal, { ...livePortal, ...changed }, false, null, null, minedPortal)).verified)
            .toBe(false);
    }
    const inherited = await readSavedPlayerStats(stats);
    expect((await verifySurvival(stats, goal, livePortal, false, inherited, null, minedPortal)).verified).toBe(false);
    const noEntry = await saveWorld(minedPortalStats, { criteria: {}, done: false });
    expect((await verifySurvival(noEntry, goal, livePortal, false, null, null, minedPortal)).verified).toBe(false);
});

test("strict proof rejects decreasing inherited material counters", async () => {
    const stats = await saveWorld({
        ...minedPortalStats, "minecraft:picked_up": { "minecraft:diamond": 4, "minecraft:obsidian": 11 },
    }, { criteria: {}, done: false });
    const before = await readSavedPlayerStats(stats);
    await writeFile(join(stats, player), JSON.stringify({ stats: minedPortalStats }));
    await writeFile(join(stats, "..", "advancements", player), JSON.stringify({
        "minecraft:story/enter_the_nether": netherAdvancement,
    }));
    expect((await verifySurvival(stats, goal, livePortal, false, before, null, minedPortal)).verified).toBe(false);
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
