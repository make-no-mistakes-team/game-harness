package io.gameharness.survival;

import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.inventory.SimpleInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

final class OrdinaryHotbarTest {
    @BeforeAll static void vanilla() { VanillaTestResources.initialize(); }

    @Test void offBarDirtCanFillASpareSlotWithoutReplacingTheHeldTool() {
        var inventory = new SimpleInventory(PlayerInventory.MAIN_SIZE);
        var bar = new net.minecraft.item.Item[] { Items.WOODEN_PICKAXE, Items.WOODEN_SHOVEL, Items.WOODEN_AXE,
            Items.STONE_PICKAXE, Items.STICK, Items.OAK_LOG };
        for (int i = 0; i < bar.length; i++) inventory.setStack(i, new ItemStack(bar[i]));
        inventory.setStack(8, new ItemStack(Items.BIRCH_PLANKS));
        inventory.setStack(15, new ItemStack(Items.DIRT, 33));
        int slots = AgentHands.utilitySlots(2, inventory);
        assertEquals(15, slots / PlayerInventory.HOTBAR_SIZE);
        assertEquals(6, slots % PlayerInventory.HOTBAR_SIZE);
        assertEquals(7, AgentHands.utilitySlots(6, inventory) % PlayerInventory.HOTBAR_SIZE,
            "leave the selected empty hand available");
        inventory.setStack(7, new ItemStack(Items.COBBLESTONE));
        assertEquals(-1, AgentHands.utilitySlots(2, inventory), "a ready block already serves this purpose");
    }

    @Test void unavailableSpaceOrOnlyFallingMaterialDoesNotDisplaceOtherSupplies() {
        var inventory = new SimpleInventory(PlayerInventory.MAIN_SIZE);
        inventory.setStack(28, new ItemStack(Items.GRAVEL, 32));
        assertEquals(-1, AgentHands.utilitySlots(0, inventory));
        inventory.setStack(28, new ItemStack(Items.DIRT, 32));
        for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++)
            inventory.setStack(slot, new ItemStack(Items.BREAD));
        assertEquals(-1, AgentHands.utilitySlots(0, inventory));
    }
}
