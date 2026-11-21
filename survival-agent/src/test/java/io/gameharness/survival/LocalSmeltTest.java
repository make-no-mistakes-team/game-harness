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
    void aConfirmedMultiLoadCanWatchTheWorldWithoutAnyWorkshopRecipe() {
        var batch = new AgentLocalSmelt.Batch(Items.BIRCH_LOG, 2, 0);
        var watch = new AgentLocalSmelt.Watch();
        assertFalse(watch.canLeave(batch, AgentLocalSmelt.View.SYNCING, true));
        assertFalse(watch.canLeave(batch, AgentLocalSmelt.View.COOKING, false));
        assertTrue(watch.canLeave(batch, AgentLocalSmelt.View.COOKING, true));

        watch.leave(100, 30, 2, 0.5f);
        assertFalse(watch.seesWorld(30));
        assertTrue(watch.seesWorld(31));
        assertTrue(watch.mayStepOut(101));
        assertFalse(watch.mayStepOut(190), "the watch does not start a detour after the short side-work window");
        assertFalse(watch.recheckDue(399));
        assertTrue(watch.recheckDue(400));
        assertFalse(watch.recheckExpired(400));
        assertTrue(watch.recheckExpired(460), "normal furnace recovery can resume if the screen cannot be opened");
        watch.reopen();
        assertFalse(watch.active());
        assertFalse(watch.canLeave(batch, AgentLocalSmelt.View.COOKING, true),
            "reopening an unfinished batch cannot restart the handoff");
    }

    @Test
    void anOriginalSingletonStillWatchesInItsScreenAfterAReopen() {
        var batch = new AgentLocalSmelt.Batch(Items.BIRCH_LOG, 1, 0);
        var watch = new AgentLocalSmelt.Watch();
        assertFalse(watch.canLeave(batch, AgentLocalSmelt.View.COOKING, true));
        watch.reopen();
        assertFalse(watch.canLeave(batch, AgentLocalSmelt.View.COOKING, true));

        var resumed = new AgentLocalSmelt.Watch();
        resumed.reopen();
        assertFalse(resumed.canLeave(new AgentLocalSmelt.Batch(Items.BIRCH_LOG, 2, 0),
            AgentLocalSmelt.View.COOKING, true));
    }

    @Test
    void recheckUsesRemainingInputsWithoutChangingThePaidUnits() {
        var batch = new AgentLocalSmelt.Batch(Items.BIRCH_LOG, 2, 0);
        var watch = new AgentLocalSmelt.Watch();
        var partial = new ItemStack(Items.CHARCOAL);
        var cooking = batch.view(true, true, new ItemStack(Items.BIRCH_LOG), partial);
        assertTrue(watch.canLeave(batch, cooking, true), "the last input of a multi-load is not a singleton");
        watch.leave(100, 30, 1, 0.75f);
        assertFalse(watch.mayStepOut(101), "only passive work has time before this recheck");
        assertFalse(watch.recheckDue(149));
        assertTrue(watch.recheckDue(150));
        watch.reopen();
        assertEquals(AgentLocalSmelt.View.CHANGED,
            batch.view(true, true, new ItemStack(Items.BIRCH_LOG, 2), partial),
            "a duplicate load cannot match the original paid units");
        assertEquals(AgentLocalSmelt.View.READY,
            batch.view(true, false, ItemStack.EMPTY, new ItemStack(Items.CHARCOAL, 2)));
    }

    @Test
    void aLargePaidLoadStillHasABoundedFirstRecheck() {
        var watch = new AgentLocalSmelt.Watch();
        watch.leave(100, 30, 6, 0);
        assertFalse(watch.recheckDue(699));
        assertTrue(watch.recheckDue(700));
    }

    @Test
    void oneVisiblePickupCreditsOnlyAnObservedInventoryGain() {
        var watch = new AgentLocalSmelt.Watch();
        watch.leave(100, 30, 2, 0);
        assertEquals(0, watch.observePickup(5), "unrelated stock gains before any sighting are not credited");
        watch.targetPickup(5);
        assertEquals(0, watch.observePickup(5), "overlap or disappearance is not a receipt");
        assertEquals(1, watch.observePickup(6));
        assertEquals(0, watch.observePickup(6), "the same pickup cannot be counted twice");
        assertFalse(watch.canTargetPickup());
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
