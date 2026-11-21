package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class LocalSmeltTest {
    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void eligibilityToLeaveDependsOnPaidUnitsNotTheLastInputSlotCount() {
        var iron = new AgentLocalSmelt.Batch(Items.RAW_IRON, 3, 0);
        var charcoal = new AgentLocalSmelt.Batch(Items.OAK_LOG, 1, 0);
        assertEquals(AgentLocalSmelt.View.COOKING, iron.view(true, true,
            new ItemStack(Items.RAW_IRON), new ItemStack(Items.IRON_INGOT, 2)));
        assertTrue(iron.mayDoSideWork());
        assertFalse(charcoal.mayDoSideWork());
        assertEquals(AgentLocalSmelt.View.COOKING, charcoal.view(true, true,
            new ItemStack(Items.OAK_LOG), ItemStack.EMPTY));
    }

    @Test
    void reopeningDoesNotCollectAndMismatchedOrUnsentSlotsAreNotResults() {
        var iron = new AgentLocalSmelt.Batch(Items.RAW_IRON, 3, 1);
        var take = new AgentLocalSmelt.Withdrawal();
        var result = new ItemStack(Items.IRON_INGOT, 3);
        assertEquals(AgentLocalSmelt.View.SYNCING, iron.view(false, false, ItemStack.EMPTY, result));
        assertEquals(AgentLocalSmelt.View.CHANGED, iron.view(true, false, ItemStack.EMPTY, ItemStack.EMPTY));
        assertEquals(AgentLocalSmelt.View.CHANGED, iron.view(true, true,
            new ItemStack(Items.RAW_IRON, 3), ItemStack.EMPTY));
        assertEquals(AgentLocalSmelt.View.READY, iron.view(true, false, ItemStack.EMPTY, result));
        assertFalse(take.hasStoredResult());
        take.store();
        assertFalse(take.hasStoredResult());
        take.take();
        assertFalse(take.hasStoredResult());
        take.store();
        assertTrue(take.hasStoredResult());
    }
}
