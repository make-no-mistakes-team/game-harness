package io.gameharness.survival;

import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;

/** Local meal policy and exact model-authorized food sources. */
final class AgentFoodWork {
    static final String EFFECT = "forage:";
    static final int MAX_SWINGS = 4;
    static final int MAX_TICKS = 110;
    static final int DROP_TICKS = 22;
    static final double LEASH = 4;

    enum Source {
        SWEET_BERRIES("block", "sweet_berry_bush", Items.SWEET_BERRIES),
        GLOW_VINES("block", "cave_vines", Items.GLOW_BERRIES),
        GLOW_PLANT("block", "cave_vines_plant", Items.GLOW_BERRIES),
        COW("entity", "cow", Items.BEEF, Items.COOKED_BEEF),
        MOOSHROOM("entity", "mooshroom", Items.BEEF, Items.COOKED_BEEF),
        PIG("entity", "pig", Items.PORKCHOP, Items.COOKED_PORKCHOP),
        SHEEP("entity", "sheep", Items.MUTTON, Items.COOKED_MUTTON),
        RABBIT("entity", "rabbit", Items.RABBIT, Items.COOKED_RABBIT);

        final String subject, effect;
        final Item item, cooked;
        final ItemStack stock;

        Source(String kind, String name, Item item) {
            this(kind, name, item, null);
        }

        Source(String kind, String name, Item item, Item cooked) {
            subject = kind + ":minecraft:" + name;
            effect = EFFECT + subject;
            this.item = item;
            this.cooked = cooked;
            stock = new ItemStack(item);
        }

        boolean animal() { return ordinal() >= COW.ordinal(); }
        boolean matchesDrop(ItemStack stack) { return stack.isOf(item) || cooked != null && stack.isOf(cooked); }
    }

    private static final Source[] SOURCES = Source.values();

    static Source effect(String effect) {
        for (Source source : SOURCES) if (source.effect.equals(effect)) return source;
        return null;
    }

    static Source ripe(BlockState state) {
        if (state.isOf(Blocks.SWEET_BERRY_BUSH) && state.get(SweetBerryBushBlock.AGE) >= 2) return Source.SWEET_BERRIES;
        if (state.isOf(Blocks.CAVE_VINES) && state.get(CaveVines.BERRIES)) return Source.GLOW_VINES;
        if (state.isOf(Blocks.CAVE_VINES_PLANT) && state.get(CaveVines.BERRIES)) return Source.GLOW_PLANT;
        return null;
    }

    static Source adult(Entity entity) {
        if (!(entity instanceof LivingEntity animal) || !animal.isAlive() || animal.isBaby() || animal.isTouchingWater()) return null;
        EntityType<?> type = entity.getType();
        if (type == EntityType.COW) return Source.COW;
        if (type == EntityType.MOOSHROOM) return Source.MOOSHROOM;
        if (type == EntityType.PIG) return Source.PIG;
        if (type == EntityType.SHEEP) return Source.SHEEP;
        if (type == EntityType.RABBIT) return Source.RABBIT;
        return null;
    }

    static boolean criticalForage(int hunger, float health, boolean safe) {
        return safe && (hunger == 0 || hunger < 18 && health <= 7);
    }

    static boolean canPauseRoute(int hunger, boolean waitingForEvidence, boolean critical) {
        return critical || hunger <= 10 && waitingForEvidence;
    }

    static boolean safeMeal(ItemStack stack) {
        return positiveNutrition(stack) && !stack.isOf(Items.ROTTEN_FLESH) && !stack.isOf(Items.SPIDER_EYE)
            && !stack.isOf(Items.POISONOUS_POTATO) && !stack.isOf(Items.PUFFERFISH)
            && !stack.isOf(Items.CHICKEN) && !stack.isOf(Items.SUSPICIOUS_STEW) && !stack.isOf(Items.CHORUS_FRUIT);
    }

    static boolean fleshMeal(ItemStack stack) {
        return stack.isOf(Items.ROTTEN_FLESH) && positiveNutrition(stack);
    }

    private static boolean positiveNutrition(ItemStack stack) {
        var food = stack.get(DataComponentTypes.FOOD);
        return !stack.isEmpty() && food != null && food.nutrition() > 0;
    }

    static boolean improvisedWeapon(ItemStack stack) {
        return stack.isIn(ItemTags.PICKAXES) && Registries.ITEM.getId(stack.getItem()).getNamespace().equals("minecraft")
            && stack.getMaxDamage() - stack.getDamage() > 2;
    }

    static boolean criticalHuntContact(double squaredDistance, double reach, boolean dryTarget) {
        return dryTarget && reach > 0 && squaredDistance <= reach * reach;
    }

    static boolean safeWeapon(ItemStack stack) {
        // Unlike a charged sword swing, an axe cannot sweep other entities.
        // Reserve more than the maximum two wear of a vanilla axe hit.
        return stack.isIn(ItemTags.AXES)
            && Registries.ITEM.getId(stack.getItem()).getNamespace().equals("minecraft")
            && stack.getMaxDamage() - stack.getDamage() > 2;
    }

    static int pickupGain(int before, int carried, boolean removed, boolean matchingStock) {
        return removed || matchingStock ? Math.max(0, carried - before) : 0;
    }

    static int ordinaryPickupGain(int before, int carried, int witnessed, int remaining) {
        return Math.max(0, Math.min(carried - before, witnessed - remaining));
    }

    static boolean policy(Source source, AgentWorkOrder.Target target, Map<Item, Integer> caps,
                          int effects, int breaks, int crafts, int placements) {
        return target.item() == source.item && caps.isEmpty() && effects == 1
            && breaks == 0 && crafts == 0 && placements == 0;
    }

    private AgentFoodWork() {}
}
