package io.gameharness.survival;

import java.util.function.IntPredicate;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/** One actual diamond harvest must remain affordable after a preparatory cover cut. */
final class AgentProspectTools {
    // A nonnegative result is an inventory slot (or item count loss for coverLoss).
    static final int NO_HARVEST_TOOL = -1;
    static final int HARVEST_UNEQUIPPABLE = -2;
    static final int HARVEST_UNKNOWN_WEAR = -3;
    static final int HARVEST_UNPRICED = -4;
    static final int HARVEST_PROTECTED = -5;
    static final int HARVEST_BREAKS_SPENT = -6;
    static final int NO_COVER_TOOL = -1;
    static final int COVER_UNKNOWN_WEAR = -2;
    static final int COVER_UNPRICED = -3;
    static final int COVER_STOCK_PROTECTED = -4;
    static final int COVER_LOSES_HARVEST = -5;

    private static final ItemStack DIAMOND_DROP = new ItemStack(Items.DIAMOND);
    private static final BlockState DIAMOND_ORE = Blocks.DIAMOND_ORE.getDefaultState();
    private static final BlockState DEEPSLATE_ORE = Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState();

    private AgentProspectTools() {}

    static boolean isOre(BlockState state) { return state == DIAMOND_ORE || state == DEEPSLATE_ORE; }

    static boolean roomForDiamond(PlayerInventory inventory) {
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            ItemStack stack = inventory.getStack(slot);
            if (stack.isEmpty() || stack.isOf(Items.DIAMOND) && stack.getCount() < stack.getMaxCount()
                    && ItemStack.areItemsAndComponentsEqual(stack, DIAMOND_DROP)) return true;
        }
        return false;
    }

    static int harvestLoss(ItemStack stack, BlockState ore, BlockView world, BlockPos pos) {
        long wear = AgentMiningStock.maxWear(stack, ore, world, pos);
        return AgentMiningStock.knownWear(wear) ? AgentMiningStock.lossForWear(stack, wear) : AgentMiningStock.UNKNOWN;
    }

    static int harvestSlot(PlayerInventory inventory, BlockState ore, BlockView world, BlockPos pos,
                           AgentWorkOrder.Budget budget, IntPredicate equip) {
        return harvestSlot(inventory, ore, world, pos, budget, equip, -1, 0, 0);
    }

    private static int harvestSlot(PlayerInventory inventory, BlockState ore, BlockView world, BlockPos pos,
                                   AgentWorkOrder.Budget budget, IntPredicate equip, int coverSlot, long coverWear, int coverLoss) {
        if (budget != null && budget.breaksLeft() <= (coverSlot < 0 ? 0 : 1)) return HARVEST_BREAKS_SPENT;
        boolean deep = ore != DIAMOND_ORE && (budget == null || budget.policy.breakAllowed(DEEPSLATE_ORE));
        boolean plain = ore != DEEPSLATE_ORE && (budget == null || budget.policy.breakAllowed(DIAMOND_ORE));
        if (!deep && !plain) return NO_HARVEST_TOOL;

        int best = NO_HARVEST_TOOL;
        Item spent = coverLoss == 0 ? Items.AIR : inventory.getStack(coverSlot).getItem();
        float speed = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            if (slot == coverSlot && coverLoss > 0) continue;
            ItemStack stack = inventory.getStack(slot);
            BlockState candidate = deep && oreCompatible(stack, DEEPSLATE_ORE) ? DEEPSLATE_ORE
                : plain && oreCompatible(stack, DIAMOND_ORE) ? DIAMOND_ORE : null;
            if (candidate == null) continue;
            int result = HARVEST_UNEQUIPPABLE;
            if (equip.test(slot)) {
                long wear = AgentMiningStock.maxWear(stack, candidate, world, pos);
                result = HARVEST_UNKNOWN_WEAR;
                if (AgentMiningStock.knownWear(wear)) {
                    int loss = AgentMiningStock.lossForWear(stack, wear + (slot == coverSlot ? coverWear : 0));
                    result = harvestSpendRefusal(inventory, stack.getItem(), budget, loss, stack.isOf(spent) ? coverLoss : 0);
                }
            }
            if (result < 0) {
                if (best < 0) best = Math.min(best, result);
                continue;
            }
            // With no witnessed ore, any admissible inventory tool is a sufficient witness.
            if (ore == null) return slot;
            float nextSpeed = stack.getMiningSpeedMultiplier(candidate);
            if (best < 0 || nextSpeed > speed || nextSpeed == speed && slot == inventory.selectedSlot) {
                best = slot;
                speed = nextSpeed;
            }
        }
        return best;
    }

    private static int harvestSpendRefusal(PlayerInventory inventory, Item item, AgentWorkOrder.Budget budget,
                                          int harvestLoss, int coverLoss) {
        if (harvestLoss == 0) return 0;
        if (budget == null) return HARVEST_UNPRICED;
        int total = harvestLoss + coverLoss;
        if (AgentWorkOrder.count(inventory, item) - budget.floor(item) < total) return HARVEST_PROTECTED;
        return budget.remainingCost(item) < total ? HARVEST_UNPRICED : 0;
    }

    static int coverSlot(PlayerInventory inventory, BlockState cover, BlockView world, BlockPos pos,
                         AgentWorkOrder.Budget budget, AgentWorkOrder.Budget idleFloor, IntPredicate equip) {
        if (budget != null && !budget.canCutCover()) return COVER_LOSES_HARVEST;
        int harvest = harvestSlot(inventory, null, world, pos, budget, equip);
        int best = NO_COVER_TOOL, bestLoss = Integer.MAX_VALUE;
        float speed = 0;
        int refusal = NO_COVER_TOOL;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            ItemStack stack = inventory.getStack(slot);
            if (!compatible(stack, cover) || !equip.test(slot)) continue;
            float nextSpeed = stack.getMiningSpeedMultiplier(cover);
            if (budget != null && best >= 0 && (nextSpeed < speed || nextSpeed == speed && slot != inventory.selectedSlot))
                continue;
            int loss = coverLoss(inventory, slot, cover, world, pos, budget, idleFloor, equip, harvest);
            if (loss < 0) {
                refusal = Math.min(refusal, loss);
                continue;
            }
            if (best < 0 || budget == null && loss < bestLoss
                    || (budget != null || loss == bestLoss)
                        && (nextSpeed > speed || nextSpeed == speed && slot == inventory.selectedSlot)) {
                best = slot;
                bestLoss = loss;
                speed = nextSpeed;
            }
        }
        return best >= 0 ? best : refusal;
    }

    static int coverLoss(PlayerInventory inventory, int slot, BlockState cover, BlockView world, BlockPos pos,
                         AgentWorkOrder.Budget budget, IntPredicate equip) {
        if (!compatible(inventory.getStack(slot), cover) || !equip.test(slot)) return NO_COVER_TOOL;
        return coverLoss(inventory, slot, cover, world, pos, budget, null, equip, -1);
    }

    private static int coverLoss(PlayerInventory inventory, int slot, BlockState cover, BlockView world, BlockPos pos,
                                 AgentWorkOrder.Budget budget, AgentWorkOrder.Budget idleFloor, IntPredicate equip,
                                 int currentHarvest) {
        ItemStack stack = inventory.getStack(slot);
        long wear = AgentMiningStock.maxWear(stack, cover, world, pos);
        if (!AgentMiningStock.knownWear(wear)) return COVER_UNKNOWN_WEAR;
        int loss = AgentMiningStock.lossForWear(stack, wear);
        if (loss > 0) {
            Item item = stack.getItem();
            int count = AgentWorkOrder.count(inventory, item);
            var floor = budget == null ? idleFloor : budget;
            if (count - (floor == null ? 0 : floor.floor(item)) < loss) return COVER_STOCK_PROTECTED;
            if (budget != null && budget.remainingCost(item) < loss) return COVER_UNPRICED;
        }
        // No stock loss means the other slot and its policy headroom are untouched.
        if (currentHarvest >= 0 && loss == 0 && (currentHarvest != slot || wear == 0)) return 0;
        return harvestSlot(inventory, null, world, pos, budget, equip, slot, wear, loss) >= 0 ? loss : COVER_LOSES_HARVEST;
    }

    private static boolean compatible(ItemStack stack, BlockState block) {
        return (!block.isToolRequired() || stack.isSuitableFor(block)) && AgentMiningStock.lootCompatible(stack, block);
    }

    private static boolean oreCompatible(ItemStack stack, BlockState ore) {
        return stack.isSuitableFor(ore) && AgentMiningStock.lootCompatible(stack, ore);
    }
}
