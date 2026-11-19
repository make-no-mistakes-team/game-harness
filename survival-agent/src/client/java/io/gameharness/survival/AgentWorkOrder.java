package io.gameharness.survival;

import com.google.gson.JsonObject;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.Identifier;

/** A finite, host-issued lease. Geometry, recipes and inputs are native decisions. */
record AgentWorkOrder(String id, int life, long epoch, long basis, long expires, long safetyRevision,
                      Policy policy, String nextWorkId) {
    static final int MAX_TICKS = 1_200;
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern ITEM_ID = Pattern.compile("minecraft:[a-z0-9_]{1,96}");
    private static final Set<String> FIELDS = Set.of("v", "id", "run", "life", "epoch", "basisTick", "expiresTick",
        "safetyRevision", "origin", "target", "allowedEffects", "costCaps", "reserves",
        "maxBreaks", "maxCrafts", "maxPlacements");
    private static final Set<String> GOALS = Set.of("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal");
    private static final String TABLE = "place:minecraft:crafting_table";

    record Target(Item item, int count, String goal) {}

    record Policy(boolean preset, Target target, Set<String> effects, Map<Item, Integer> caps,
                  Map<Item, Integer> floors, int maxBreaks, int maxCrafts, int maxPlacements) {
        boolean breakAllowed(BlockState state) {
            return resource(state) && (preset || namedBreak(state));
        }

        boolean prospectCoverAllowed(BlockState state) {
            return prospectCoverDrop(state) != Items.AIR && (preset
                ? !target.goal.equals("wooden_pickaxe")
                : namedBreak(state));
        }

        private boolean namedBreak(BlockState state) {
            return effects.contains("break:" + Registries.BLOCK.getId(state.getBlock()));
        }

        boolean craftAllowed(String recipe) {
            return preset || effects.contains("craft:" + recipe)
                || AgentHands.workSpecificPlanks(recipe) && effects.contains("craft:planks");
        }
        boolean placeTable() { return preset || effects.contains(TABLE); }
    }

    /** Charges actual effects, or their conservative bound at the irreversible edge. */
    static final class Budget {
        final Policy policy;
        private final Map<Item, Integer> spent = new HashMap<>();
        private int breaks, crafts, placements;

        Budget(Policy policy) { this.policy = policy; }
        boolean canBreak() { return breaks < policy.maxBreaks; }
        boolean canCutCover() { return policy.maxBreaks - breaks > 1; }
        boolean canPlace() { return placements < policy.maxPlacements; }
        int craftsLeft() { return policy.maxCrafts - crafts; }
        boolean nearLimit() {
            return breaks > 0 && policy.maxBreaks - breaks <= 2
                || crafts > 0 && craftsLeft() <= 2
                || placements > 0 && policy.maxPlacements - placements <= 1;
        }

        int limit(Item item, int current) {
            return Math.max(0, Math.min(current - floor(item), remainingCost(item)));
        }

        int floor(Item item) { return policy.floors.getOrDefault(item, 0); }
        Map.Entry<Item, Integer> missingFloor(PlayerInventory inventory) {
            Map.Entry<Item, Integer> missing = null;
            for (var floor : policy.floors.entrySet()) {
                if (count(inventory, floor.getKey()) >= floor.getValue()) continue;
                if (missing == null || Registries.ITEM.getId(floor.getKey()).compareTo(Registries.ITEM.getId(missing.getKey())) < 0)
                    missing = floor;
            }
            return missing;
        }

        int remainingCost(Item item) {
            int cap = policy.preset ? Integer.MAX_VALUE : policy.caps.getOrDefault(item, 0);
            return cap - spent.getOrDefault(item, 0);
        }

        private void charge(Item item, int count) {
            if (count > 0) spent.merge(item, count, Integer::sum);
        }

        void broken(Item tool, int loss) { ++breaks; charge(tool, loss); }
        void placedTable() { ++placements; charge(Items.CRAFTING_TABLE, 1); }

        void crafted(Map<Item, Integer> costs, int executions) {
            crafts += executions;
            costs.forEach(this::charge);
        }
    }

    static AgentWorkOrder parse(JsonObject value, String run, String mode) {
        if (mode == null || value == null || !value.keySet().containsAll(FIELDS)
                || value.size() != FIELDS.size() + (value.has("nextWorkId") ? 1 : 0)) return null;
        AgentWorkOrder envelope;
        try {
            if (integer(value, "v") != 1 || !run.equals(text(value, "run"))) return null;
            String id = text(value, "id");
            if (!ID.matcher(id).matches() || id.equals(".") || id.equals("..")) return null;
            long life = integer(value, "life"), epoch = integer(value, "epoch"), basis = integer(value, "basisTick");
            long expires = integer(value, "expiresTick"), safety = integer(value, "safetyRevision");
            if (life < 1 || life > Integer.MAX_VALUE || epoch < 1 || safety < 1 || basis < 1
                    || expires <= basis || expires - basis > MAX_TICKS) return null;
            envelope = new AgentWorkOrder(id, (int) life, epoch, basis, expires, safety, null, null);
        } catch (RuntimeException invalid) {
            return null;
        }
        try {
            String origin = text(value, "origin");
            boolean preset = origin.equals("preset");
            if (preset ? !"preset".equals(mode) : !origin.equals("model")) return envelope;
            String nextWorkId = value.has("nextWorkId") ? text(value, "nextWorkId") : null;
            if (nextWorkId != null && (preset || !ID.matcher(nextWorkId).matches()
                    || !adjacentStage(envelope.id, nextWorkId))) return envelope;
            JsonObject target = value.getAsJsonObject("target");
            Target desired;
            switch (text(target, "kind")) {
                case "stock" -> {
                    if (preset || !target.keySet().equals(Set.of("kind", "item", "count"))) return envelope;
                    desired = new Target(item(text(target, "item")), bounded(target, "count", 1, 2_304), null);
                }
                case "preset" -> {
                    if (!target.keySet().equals(Set.of("kind", "goal"))) return envelope;
                    String goal = text(target, "goal");
                    if (!GOALS.contains(goal)) return envelope;
                    desired = new Target(null, 0, goal);
                }
                default -> { return envelope; }
            }
            var effects = new HashSet<String>();
            var rawEffects = value.getAsJsonArray("allowedEffects");
            if (rawEffects.size() > 64 || preset && !rawEffects.isEmpty()) return envelope;
            for (var primitive : rawEffects) {
                if (!primitive.isJsonPrimitive() || !primitive.getAsJsonPrimitive().isString()) return envelope;
                String effect = primitive.getAsString();
                if (!validEffect(effect) || !effects.add(effect)) return envelope;
            }
            Map<Item, Integer> caps = stock(value, "costCaps");
            Map<Item, Integer> floors = stock(value, "reserves");
            if (preset && !caps.isEmpty()) return envelope;
            Policy policy = new Policy(preset, desired, Set.copyOf(effects), caps, floors,
                bounded(value, "maxBreaks", 0, preset ? 32 : 64),
                bounded(value, "maxCrafts", 0, preset ? 24 : 64),
                bounded(value, "maxPlacements", 0, preset ? 2 : 8));
            return new AgentWorkOrder(envelope.id, envelope.life, envelope.epoch, envelope.basis, envelope.expires,
                envelope.safetyRevision, policy, nextWorkId);
        } catch (RuntimeException invalid) {
            return envelope;
        }
    }

    private static boolean adjacentStage(String id, String next) {
        int end = id.length() - 1;
        return end > 1 && id.charAt(end - 1) == ':' && next.length() == id.length()
            && id.charAt(end) >= '1' && id.charAt(end) < '3'
            && next.charAt(end) == id.charAt(end) + 1 && next.regionMatches(0, id, 0, end);
    }

    private static boolean validEffect(String effect) {
        if (effect.startsWith("craft:")) return AgentHands.workRecipe(effect.substring("craft:".length()));
        if (effect.equals(TABLE)) return true;
        if (!effect.startsWith("break:")) return false;
        String id = effect.substring("break:".length());
        if (!ITEM_ID.matcher(id).matches()) return false;
        BlockState state = Registries.BLOCK.get(Identifier.of(id)).getDefaultState();
        return resource(state) || prospectCoverDrop(state) != Items.AIR;
    }

    private static Map<Item, Integer> stock(JsonObject value, String field) {
        var raw = value.getAsJsonArray(field);
        if (raw.size() > 32) throw new IllegalArgumentException(field);
        var result = new HashMap<Item, Integer>();
        for (var element : raw) {
            var pair = element.getAsJsonObject();
            if (!pair.keySet().equals(Set.of("item", "count"))
                    || result.put(item(text(pair, "item")), bounded(pair, "count", 1, 2_304)) != null)
                throw new IllegalArgumentException(field);
        }
        return Map.copyOf(result);
    }

    private static Item item(String key) {
        if (!ITEM_ID.matcher(key).matches()) throw new IllegalArgumentException("item");
        Item item = Registries.ITEM.get(Identifier.of(key));
        if (item == Items.AIR) throw new IllegalArgumentException("item");
        return item;
    }

    private static String text(JsonObject object, String field) {
        var value = object.getAsJsonPrimitive(field);
        if (!value.isString()) throw new IllegalArgumentException(field);
        return value.getAsString();
    }

    private static long integer(JsonObject object, String field) {
        var value = object.getAsJsonPrimitive(field);
        if (!value.isNumber()) throw new IllegalArgumentException(field);
        return value.getAsBigDecimal().longValueExact();
    }

    private static int bounded(JsonObject object, String field, int min, int max) {
        long value = integer(object, field);
        if (value < min || value > max) throw new IllegalArgumentException(field);
        return (int) value;
    }

    static int count(PlayerInventory inventory, Item item) {
        int count = 0;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; ++i) {
            var stack = inventory.getStack(i);
            if (stack.isOf(item)) count += stack.getCount();
        }
        return count;
    }

    static boolean resource(BlockState state) { return harvest(state) != Items.AIR; }

    /** Small, dry surface-cut allowlist. Turf is admitted as cover, not as an exact stock source. */
    static Item prospectCoverDrop(BlockState state) {
        if (state.isOf(Blocks.GRASS_BLOCK) || state.isOf(Blocks.DIRT)) return Items.DIRT;
        if (state.isOf(Blocks.STONE)) return Items.COBBLESTONE;
        if (state.isOf(Blocks.DEEPSLATE)) return Items.COBBLED_DEEPSLATE;
        if (state.isOf(Blocks.ANDESITE) || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.GRANITE)
                || state.isOf(Blocks.TUFF)) return state.getBlock().asItem();
        return Items.AIR;
    }

    /** Some vanilla sources have conditional/alternative loot. Do not expose those as exact stock work. */
    static Item harvest(BlockState state) {
        if (!Registries.BLOCK.getId(state.getBlock()).getNamespace().equals("minecraft")) return Items.AIR;
        if (state.isIn(BlockTags.LOGS) || state.isOf(Blocks.BAMBOO) || state.isOf(Blocks.BAMBOO_BLOCK)
                || state.isOf(Blocks.STRIPPED_BAMBOO_BLOCK) || state.isOf(Blocks.DIRT)
                || state.isOf(Blocks.SAND) || state.isOf(Blocks.RED_SAND) || state.isOf(Blocks.CLAY)
                || state.isOf(Blocks.COBBLESTONE) || state.isOf(Blocks.COBBLED_DEEPSLATE)
                || state.isOf(Blocks.TUFF) || state.isOf(Blocks.GRANITE)
                || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.ANDESITE)) {
            return state.isOf(Blocks.CLAY) ? Items.CLAY_BALL : state.getBlock().asItem();
        }
        if (state.isOf(Blocks.STONE)) return Items.COBBLESTONE;
        if (state.isOf(Blocks.DEEPSLATE)) return Items.COBBLED_DEEPSLATE;
        if (state.isIn(BlockTags.COAL_ORES)) return Items.COAL;
        if (state.isIn(BlockTags.IRON_ORES)) return Items.RAW_IRON;
        if (state.isIn(BlockTags.COPPER_ORES)) return Items.RAW_COPPER;
        if (state.isIn(BlockTags.GOLD_ORES) && !state.isOf(Blocks.NETHER_GOLD_ORE)) return Items.RAW_GOLD;
        if (state.isIn(BlockTags.DIAMOND_ORES)) return Items.DIAMOND;
        if (state.isIn(BlockTags.REDSTONE_ORES)) return Items.REDSTONE;
        if (state.isIn(BlockTags.LAPIS_ORES)) return Items.LAPIS_LAZULI;
        if (state.isIn(BlockTags.EMERALD_ORES)) return Items.EMERALD;
        return state.isOf(Blocks.NETHER_QUARTZ_ORE) ? Items.QUARTZ : Items.AIR;
    }
}
