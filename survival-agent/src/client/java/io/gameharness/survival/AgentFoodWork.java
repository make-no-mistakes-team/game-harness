package io.gameharness.survival;

import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;

/** One model-authorized local food source, independent of general break and attack grants. */
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
        COW("entity", "cow", Items.BEEF),
        MOOSHROOM("entity", "mooshroom", Items.BEEF),
        PIG("entity", "pig", Items.PORKCHOP),
        SHEEP("entity", "sheep", Items.MUTTON),
        RABBIT("entity", "rabbit", Items.RABBIT);

        final String subject, effect;
        final Item item;
        final ItemStack stock;

        Source(String kind, String name, Item item) {
            subject = kind + ":minecraft:" + name;
            effect = EFFECT + subject;
            this.item = item;
            stock = new ItemStack(item);
        }

        boolean animal() { return ordinal() >= COW.ordinal(); }
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

    static boolean policy(Source source, AgentWorkOrder.Target target, Map<Item, Integer> caps,
                          int effects, int breaks, int crafts, int placements) {
        return target.item() == source.item && caps.isEmpty() && effects == 1
            && breaks == 0 && crafts == 0 && placements == 0;
    }

    private AgentFoodWork() {}
}
