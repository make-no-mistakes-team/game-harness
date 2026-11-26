package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ArmorItem;
import net.minecraft.item.AxeItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.item.PickaxeItem;
import net.minecraft.item.ShovelItem;
import net.minecraft.item.SwordItem;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;

/**
 * Intelligent inventory clutter detection and discard triage.
 *
 * Classifies all 36 main-inventory slots into protection & discard tiers so full
 * inventories never prevent picking up diamonds, iron, flint, food, or workstations.
 * Never discards tools, weapons, shields, buckets, flint & steel, ores/ingots,
 * fuel, torches, workstations, wood, good food, or the last stack of scaffold blocks.
 */
final class InventoryTriage {
    record SlotInfo(
        int invIndex,
        String itemPath,
        int count,
        boolean protectedItem,
        boolean isFood,
        boolean isScaffold
    ) {}

    private record RankedCandidate(int invIndex, String itemPath, int priority, int count) {}

    private static final Set<String> ALWAYS_KEEP = Set.of(
        "crafting_table", "furnace", "torch", "coal", "charcoal",
        "raw_iron", "iron_ingot", "diamond", "obsidian",
        "bucket", "water_bucket", "lava_bucket", "flint_and_steel", "flint",
        "shield", "stick", "bow"
    );

    private static final Set<String> TIER1_JUNK = Set.of(
        "wheat_seeds", "beetroot_seeds", "melon_seeds", "pumpkin_seeds",
        "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet",
        "red_tulip", "orange_tulip", "white_tulip", "pink_tulip",
        "oxeye_daisy", "cornflower", "lily_of_the_valley", "pink_petals",
        "sunflower", "lilac", "rose_bush", "peony", "short_grass", "tall_grass",
        "fern", "large_fern", "dead_bush", "vine", "lily_pad", "kelp", "seagrass",
        "rotten_flesh", "spider_eye", "poisonous_potato", "bone", "string",
        "feather", "ink_sac", "glow_ink_sac", "slime_ball", "snowball", "egg",
        "leather", "gunpowder", "amethyst_shard", "moss_block", "moss_carpet",
        "azalea", "flowering_azalea", "hanging_roots", "spore_blossom",
        "big_dripleaf", "small_dripleaf", "clay_ball", "sugar_cane",
        "raw_copper", "copper_ingot", "redstone", "lapis_lazuli",
        "raw_gold", "gold_ingot", "emerald", "glow_lichen", "sculk", "sculk_vein"
    );

    private static final Set<String> TIER2_REDUNDANT_ROCK = Set.of(
        "diorite", "granite", "andesite", "tuff", "calcite",
        "dripstone_block", "pointed_dripstone", "smooth_basalt", "basalt",
        "mud", "sand", "red_sand", "sandstone", "red_sandstone",
        "terracotta", "coarse_dirt", "rooted_dirt", "podzol", "mycelium",
        "deepslate", "stone"
    );

    private static final Set<String> BULK_SCAFFOLD = Set.of(
        "dirt", "cobbled_deepslate", "cobblestone", "netherrack"
    );

    private InventoryTriage() {}

    static int freeSlots(ClientPlayerEntity player) {
        if (player == null) return 36;
        int free = 0;
        var inv = player.getInventory();
        for (int i = 0; i < 36; i++) {
            if (inv.getStack(i).isEmpty()) free++;
        }
        return free;
    }

    static int usedSlots(ClientPlayerEntity player) {
        return 36 - freeSlots(player);
    }

    static boolean isCluttered(ClientPlayerEntity player) {
        return freeSlots(player) <= 2;
    }

    static List<Integer> chooseSlotsToDiscard(ClientPlayerEntity player, String goal, int desiredFreeSlots) {
        if (player == null) return List.of();
        int free = freeSlots(player);
        int needToDrop = Math.max(0, desiredFreeSlots - free);
        if (needToDrop == 0) return List.of();

        List<SlotInfo> slots = snapshotSlots(player, goal);
        boolean hasFlintAndSteel = GuiHands.countItem(player, Items.FLINT_AND_STEEL) > 0
            || GuiHands.countItem(player, Items.FLINT) > 0;
        return selectDiscardIndices(slots, goal, hasFlintAndSteel, needToDrop);
    }

    static List<String> summarizeDiscardCandidates(ClientPlayerEntity player, String goal, int limit) {
        if (player == null) return List.of();
        List<SlotInfo> slots = snapshotSlots(player, goal);
        boolean hasFlintAndSteel = GuiHands.countItem(player, Items.FLINT_AND_STEEL) > 0
            || GuiHands.countItem(player, Items.FLINT) > 0;
        List<Integer> indices = selectDiscardIndices(slots, goal, hasFlintAndSteel, Math.max(1, limit));
        List<String> out = new ArrayList<>();
        for (int idx : indices) {
            ItemStack st = player.getInventory().getStack(idx);
            if (!st.isEmpty()) {
                out.add(Registries.ITEM.getId(st.getItem()).getPath() + "x" + st.getCount());
            }
        }
        return out;
    }

    private static List<SlotInfo> snapshotSlots(ClientPlayerEntity player, String goal) {
        List<SlotInfo> slots = new ArrayList<>(36);
        var inv = player.getInventory();
        boolean hasBow = GuiHands.countItem(player, Items.BOW) > 0;
        for (int i = 0; i < 36; i++) {
            ItemStack st = inv.getStack(i);
            if (st.isEmpty()) continue;
            Item item = st.getItem();
            String path = Registries.ITEM.getId(item).getPath();
            boolean isTool = item instanceof PickaxeItem || item instanceof SwordItem
                || item instanceof AxeItem || item instanceof ShovelItem
                || item instanceof ArmorItem || SafeDescent.isBoatStack(st);
            boolean isWood = st.isIn(ItemTags.LOGS) || st.isIn(ItemTags.PLANKS);
            boolean goodFood = Motor.foodScore(st, false) >= 3;
            boolean prot = isTool || isWood || goodFood || ALWAYS_KEEP.contains(path)
                || (path.equals("arrow") && hasBow)
                || (goal != null && path.equals(goal));
            boolean isScaffold = BULK_SCAFFOLD.contains(path);
            slots.add(new SlotInfo(i, path, st.getCount(), prot, goodFood, isScaffold));
        }
        return slots;
    }

    /**
     * Pure, unit-testable discard selector:
     * returns up to `maxToDrop` inventory slot indices ordered from lowest to highest usefulness,
     * strictly preserving protected items and at least one primary scaffold stack.
     */
    static List<Integer> selectDiscardIndices(List<SlotInfo> slots, String goal, boolean hasFlintOrIgniter, int maxToDrop) {
        if (slots == null || slots.isEmpty() || maxToDrop <= 0) return List.of();

        // Count total stacks of each item & find the single best scaffold stack to ALWAYS preserve
        Map<String, Integer> stackCounts = new HashMap<>();
        SlotInfo primaryScaffold = null;
        for (SlotInfo s : slots) {
            stackCounts.merge(s.itemPath(), 1, Integer::sum);
            if (s.isScaffold()) {
                if (primaryScaffold == null
                        || scaffoldKeepRank(s.itemPath(), s.count()) > scaffoldKeepRank(primaryScaffold.itemPath(), primaryScaffold.count())) {
                    primaryScaffold = s;
                }
            }
        }

        // Track how many stacks of gravel we keep if we still need flint
        int gravelKept = 0;
        List<RankedCandidate> ranked = new ArrayList<>();

        for (SlotInfo s : slots) {
            if (s.protectedItem()) continue;
            if (goal != null && s.itemPath().equals(goal)) continue;
            if (primaryScaffold != null && s.invIndex() == primaryScaffold.invIndex()) continue;

            String p = s.itemPath();
            int prio = -1;

            if (TIER1_JUNK.contains(p) || p.endsWith("_sapling") || p.endsWith("_leaves")
                    || p.endsWith("_wool") || p.endsWith("_carpet") || p.equals("arrow")) {
                prio = 10; // drop pure junk first!
            } else if (p.equals("gravel")) {
                if (hasFlintOrIgniter) {
                    prio = 18;
                } else if (gravelKept == 0) {
                    gravelKept++;
                    continue; // keep 1 stack of gravel until we have flint or flint_and_steel!
                } else {
                    prio = 22;
                }
            } else if (TIER2_REDUNDANT_ROCK.contains(p) || p.endsWith("_terracotta")) {
                prio = 25;
            } else if (p.equals("dirt")) {
                prio = 35; // surplus dirt after primary scaffold preserved
            } else if (p.equals("cobbled_deepslate") || p.equals("netherrack")) {
                prio = 40; // surplus deepslate/netherrack
            } else if (p.equals("cobblestone")) {
                // Only discard surplus cobblestone stacks when carrying >= 2 stacks of cobblestone!
                if (stackCounts.getOrDefault("cobblestone", 0) >= 2) {
                    prio = 50;
                }
            } else {
                // Unknown non-protected misc item (e.g. poppy/biome drop not listed above)
                prio = 30;
            }

            if (prio >= 0) {
                ranked.add(new RankedCandidate(s.invIndex(), p, prio, s.count()));
            }
        }

        // Prefer dropping lowest priority first, and smaller partial stacks before full stacks within same tier!
        ranked.sort(Comparator.comparingInt(RankedCandidate::priority)
            .thenComparingInt(RankedCandidate::count));

        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < Math.min(maxToDrop, ranked.size()); i++) {
            out.add(ranked.get(i).invIndex());
        }
        return out;
    }

    private static int scaffoldKeepRank(String path, int count) {
        int base = switch (path) {
            case "cobblestone" -> 300;
            case "cobbled_deepslate" -> 200;
            case "dirt" -> 100;
            default -> 50;
        };
        return base + count;
    }
}
