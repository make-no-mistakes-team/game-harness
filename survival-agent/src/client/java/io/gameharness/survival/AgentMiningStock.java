package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.EnchantmentEffectComponentTypes;
import net.minecraft.enchantment.effect.value.RemoveBinomialEnchantmentEffect;
import net.minecraft.item.ItemStack;
import net.minecraft.item.ShearsItem;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/** Item count loss from the selected stack for one vanilla Survival block break. */
final class AgentMiningStock {
    static final int UNKNOWN = -1;

    private AgentMiningStock() {}

    static int maxLoss(ItemStack hand, BlockState state, BlockView world, BlockPos pos) {
        // An unrecognized block or item may supply its own mining hook.
        if (!Registries.BLOCK.getId(state.getBlock()).getNamespace().equals("minecraft")) return UNKNOWN;
        if (hand.isEmpty()) return 0;
        if (!Registries.ITEM.getId(hand.getItem()).getNamespace().equals("minecraft")) return UNKNOWN;
        if (!hand.isDamageable()) return 0;
        if (hand.getCount() != 1) return UNKNOWN;

        var tool = hand.get(DataComponentTypes.TOOL);
        boolean shears = hand.getItem() instanceof ShearsItem;
        long wear = shears && !state.isIn(BlockTags.FIRE) ? 1 : 0;
        // In 1.21.4 Item.postMine checks the live ToolComponent and skips zero hardness.
        // ShearsItem.postMine can then delegate to Item.postMine on other blocks.
        if (tool != null && tool.damagePerBlock() > 0 && (!shears || !handledByShears(state))
                && state.getHardness(world, pos) != 0) {
            wear += tool.damagePerBlock();
        }
        if (wear == 0) return 0;
        if (wear >= hand.getMaxDamage() - hand.getDamage()) return 1;

        // Vanilla Unbreaking only removes damage. If an unfamiliar item-damage effect
        // can change the wear, the single equipped damageable item could still break.
        if (hand.hasEnchantments()) {
            for (var enchantment : hand.getEnchantments().getEnchantments()) {
                for (var entry : enchantment.value().getEffect(EnchantmentEffectComponentTypes.ITEM_DAMAGE)) {
                    if (!(entry.effect() instanceof RemoveBinomialEnchantmentEffect)) return 1;
                }
            }
        }
        return 0;
    }

    private static boolean handledByShears(BlockState state) {
        return state.isIn(BlockTags.LEAVES) || state.isOf(Blocks.COBWEB) || state.isOf(Blocks.SHORT_GRASS)
            || state.isOf(Blocks.FERN) || state.isOf(Blocks.DEAD_BUSH) || state.isOf(Blocks.HANGING_ROOTS)
            || state.isOf(Blocks.VINE) || state.isOf(Blocks.TRIPWIRE) || state.isIn(BlockTags.WOOL);
    }
}
