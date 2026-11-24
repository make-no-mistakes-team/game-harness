package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.enchantment.Enchantment;
import net.minecraft.enchantment.EnchantmentHelper;
import net.minecraft.enchantment.Enchantments;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.entry.RegistryEntry;

/** Chooses from the player's inventory for a block already observed by the camera. */
final class AgentTools {
    private final MinecraftClient client;
    private final AgentHands hands;

    AgentTools(MinecraftClient client, AgentHands hands) {
        this.client = client;
        this.hands = hands;
    }

    /** Tests the vanilla tool requirement for drops, independent of the selected slot. */
    boolean canHarvest(BlockState observedState) {
        var player = client.player;
        if (player == null || observedState.isAir()) return false;
        if (!observedState.isToolRequired()) return true;
        var inventory = player.getInventory();
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            if (inventory.getStack(slot).isSuitableFor(observedState)) return true;
        }
        return false;
    }

    /** Returns true only when the best candidate is selected; otherwise asks Hands to equip it. */
    boolean readyFor(BlockState observedState) {
        return readyFor(observedState, false);
    }

    /** Clearance needs a normal break, not drops; an empty hand is a legitimate candidate. */
    boolean readyForClearance(BlockState observedState) {
        return readyFor(observedState, true);
    }

    static boolean candidateAllowed(boolean requiresTool, boolean suitable, boolean clearance) {
        return clearance || !requiresTool || suitable;
    }

    static float clearanceSpeed(float speed, boolean requiresTool, boolean suitable) {
        return speed / (requiresTool && !suitable ? 100 : 30);
    }

    private boolean readyFor(BlockState observedState, boolean clearance) {
        var player = client.player;
        if (player == null || observedState.isAir() || hands.busy()) return false;
        var inventory = player.getInventory();
        boolean requiresTool = observedState.isToolRequired();
        RegistryEntry<Enchantment> efficiency = null;
        int bestSlot = -1;
        float bestSpeed = 0;

        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inventory.getStack(slot);
            boolean suitable = stack.isSuitableFor(observedState);
            if (!candidateAllowed(requiresTool, suitable, clearance)) continue;

            float speed = stack.getMiningSpeedMultiplier(observedState);
            // Vanilla adds Efficiency's main-hand bonus only when the tool already speeds up the block.
            if (speed > 1 && stack.hasEnchantments()) {
                if (efficiency == null) {
                    efficiency = player.getWorld().getRegistryManager().getOrThrow(RegistryKeys.ENCHANTMENT)
                        .getOrThrow(Enchantments.EFFICIENCY);
                }
                int level = EnchantmentHelper.getLevel(efficiency, stack);
                if (level > 0) speed += level * level + 1;
            }
            if (clearance) speed = clearanceSpeed(speed, requiresTool, suitable);
            if (bestSlot >= 0) {
                if (speed < bestSpeed) continue;
                if (speed == bestSpeed) {
                    int cost = compareWear(stack, inventory.getStack(bestSlot));
                    if (cost > 0 || (cost == 0 && slot != inventory.selectedSlot)) continue;
                }
            }
            bestSlot = slot;
            bestSpeed = speed;
        }

        return bestSlot >= 0 && hands.equipSlot(bestSlot);
    }

    private static int compareWear(ItemStack candidate, ItemStack best) {
        int cost = damagePerBlock(candidate);
        int bestCost = damagePerBlock(best);
        if (cost == 0 || bestCost == 0) return Integer.compare(cost, bestCost);
        int enchantments = Boolean.compare(candidate.hasEnchantments(), best.hasEnchantments());
        if (enchantments != 0) return enchantments;
        boolean breaks = candidate.getMaxDamage() - candidate.getDamage() <= cost;
        boolean bestBreaks = best.getMaxDamage() - best.getDamage() <= bestCost;
        if (breaks != bestBreaks) return Boolean.compare(breaks, bestBreaks);
        int replacement = Integer.compare(candidate.getMaxDamage(), best.getMaxDamage());
        return replacement != 0 ? replacement : Integer.compare(cost, bestCost);
    }

    private static int damagePerBlock(ItemStack stack) {
        if (!stack.isDamageable()) return 0;
        var tool = stack.get(DataComponentTypes.TOOL);
        return tool == null ? 0 : tool.damagePerBlock();
    }
}
