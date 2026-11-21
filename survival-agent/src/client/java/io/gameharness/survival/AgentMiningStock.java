package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.EnchantmentEffectComponentTypes;
import net.minecraft.enchantment.Enchantments;
import net.minecraft.enchantment.effect.value.RemoveBinomialEnchantmentEffect;
import net.minecraft.item.ItemStack;
import net.minecraft.item.ShearsItem;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/** Conservative wear and item count loss for one vanilla Survival block break. */
final class AgentMiningStock {
    static final int UNKNOWN = -1;
    private static final long UNBOUNDED_WEAR = Long.MAX_VALUE;

    private AgentMiningStock() {}

    static int maxLoss(ItemStack hand, BlockState state, BlockView world, BlockPos pos) {
        long wear = maxWear(hand, state, world, pos);
        return wear < 0 ? UNKNOWN : lossForWear(hand, wear);
    }

    static boolean knownWear(long wear) { return wear >= 0 && wear < UNBOUNDED_WEAR; }

    static int lossForWear(ItemStack hand, long wear) {
        return wear > 0 && wear >= hand.getMaxDamage() - hand.getDamage() ? 1 : 0;
    }

    static long maxWear(ItemStack hand, BlockState state, BlockView world, BlockPos pos) {
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

        // Vanilla Unbreaking only removes damage. If an unfamiliar item-damage effect
        // can change the wear, stock loss is bounded but future durability is not.
        if (hand.hasEnchantments()) {
            for (var enchantment : hand.getEnchantments().getEnchantments()) {
                for (var entry : enchantment.value().getEffect(EnchantmentEffectComponentTypes.ITEM_DAMAGE)) {
                    if (!(entry.effect() instanceof RemoveBinomialEnchantmentEffect)) return UNBOUNDED_WEAR;
                }
            }
        }
        return wear;
    }

    static boolean lootCompatible(ItemStack hand, BlockState block) {
        if (!hand.hasEnchantments() || AgentWorkOrder.harvest(block) == block.getBlock().asItem()) return true;
        var enchantments = hand.getEnchantments();
        for (var enchantment : enchantments.getEnchantments()) {
            if (enchantment.matchesKey(Enchantments.SILK_TOUCH) && enchantments.getLevel(enchantment) != 0) return false;
        }
        return true;
    }

    private static boolean handledByShears(BlockState state) {
        return state.isIn(BlockTags.LEAVES) || state.isOf(Blocks.COBWEB) || state.isOf(Blocks.SHORT_GRASS)
            || state.isOf(Blocks.FERN) || state.isOf(Blocks.DEAD_BUSH) || state.isOf(Blocks.HANGING_ROOTS)
            || state.isOf(Blocks.VINE) || state.isOf(Blocks.TRIPWIRE) || state.isIn(BlockTags.WOOL);
    }
}
