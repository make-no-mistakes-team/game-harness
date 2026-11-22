package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.FuelRegistry;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.DynamicRegistryManager;
import net.minecraft.registry.Registries;
import net.minecraft.resource.featuretoggle.FeatureFlags;
import net.minecraft.text.Text;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class LocalSmeltTest {
    private static FuelRegistry fuels;

    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
        fuels = FuelRegistry.createDefault(DynamicRegistryManager.of(Registries.REGISTRIES),
            FeatureFlags.VANILLA_FEATURES);
    }

    @Test
    void firstIronPickCanUseThreeActualPartialLoadsAfterMakingItsHandles() {
        var wood = new ItemStack(Items.WOODEN_PICKAXE);
        wood.setDamage(20);
        var inventory = ironStock(new ItemStack(Items.BIRCH_PLANKS, 3), wood,
            new ItemStack(Items.STONE_PICKAXE), new ItemStack(Items.STONE_PICKAXE),
            new ItemStack(Items.WOODEN_SHOVEL), new ItemStack(Items.RAW_IRON, 3),
            new ItemStack(Items.CRAFTING_TABLE));

        assertEquals("stick", ironPlan(inventory, 3).preparation());
        assertEquals(3, inventory.getStack(0).getCount(), "quoting does not spend stock");
        inventory.getStack(0).decrement(2);
        inventory.setStack(7, new ItemStack(Items.STICK, 4));

        var plank = ironPlan(inventory, 3).first();
        assertEquals(Items.BIRCH_PLANKS, plank.item());
        assertEquals(1, plank.units());
        inventory.getStack(plank.slot()).decrement(plank.count());

        var pick = ironPlan(inventory, 2).first();
        assertEquals(Items.WOODEN_PICKAXE, pick.item());
        assertEquals(1, pick.units());
        inventory.getStack(pick.slot()).decrement(pick.count());

        var surplus = ironPlan(inventory, 1).first();
        assertEquals(Items.STICK, surplus.item());
        assertEquals(2, surplus.count());
        inventory.getStack(surplus.slot()).decrement(surplus.count());
        assertEquals(2, inventory.getStack(7).getCount());
        assertNull(ironPlan(inventory, 1), "the final handles are not heat");
        assertTrue(inventory.getStack(4).isOf(Items.WOODEN_SHOVEL));
    }

    @Test
    void missingHeatAndProtectedPicksDoNotFundNewRawIron() {
        var spare = new ItemStack(Items.STONE_PICKAXE);
        spare.setDamage(spare.getMaxDamage() - 1);
        var solePick = new ItemStack(Items.WOODEN_PICKAXE);
        var inventory = ironStock(new ItemStack(Items.STICK, 3), solePick, spare,
            new ItemStack(Items.WOODEN_SHOVEL), new ItemStack(Items.OAK_SAPLING));
        assertNull(ironPlan(inventory, 1), "one stick is not a cook and a nearly broken upgrade is not a reserve");

        inventory.setStack(2, new ItemStack(Items.STONE_PICKAXE));
        assertEquals(Items.WOODEN_PICKAXE, ironPlan(inventory, 1).first().item());
        assertNull(AgentHands.ordinaryIronPlan(inventory, 1, 0, 2, fuels, slot -> false, ItemStack.EMPTY, false),
            "an upgrade the hands cannot equip is not a usable reserve");
        solePick.set(DataComponentTypes.CUSTOM_NAME, Text.literal("Keepsake"));
        assertNull(ironPlan(inventory, 1), "a modified wooden pick is protected");
    }

    @Test
    void ordinaryIronQuoteUsesFullCoalBatchesAndAccountsForTheVisibleFuelSlot() {
        var inventory = ironStock(new ItemStack(Items.BIRCH_PLANKS, 2), new ItemStack(Items.STICK, 4),
            new ItemStack(Items.COAL), new ItemStack(Items.WOODEN_PICKAXE), new ItemStack(Items.STONE_PICKAXE));
        var coal = ironPlan(inventory, 3).first();
        assertEquals(Items.COAL, coal.item());
        assertEquals(3, coal.units());
        assertEquals(1, coal.count());
        inventory.setStack(2, ItemStack.EMPTY);
        var planks = ironPlan(inventory, 3).first();
        assertEquals(Items.BIRCH_PLANKS, planks.item());
        assertEquals(3, planks.units(), "a single fully funded load beats opening successive weak loads");

        var stick = AgentHands.ordinaryIronPlan(inventory, 1, 0, 2, fuels, slot -> true,
            new ItemStack(Items.STICK), true).first();
        assertEquals(Items.STICK, stick.item());
        assertEquals(1, stick.count(), "the visible stick supplies only half the required heat");
        assertNull(AgentHands.ordinaryIronPlan(ironStock(new ItemStack(Items.STICK, 2), new ItemStack(Items.COAL)),
            1, 0, 2, fuels, slot -> true, new ItemStack(Items.STICK), true),
            "unlike fuel cannot share the slot and the last handles are not payable");
        assertNull(AgentHands.ordinaryIronPlan(inventory, 1, 0, 2, fuels, slot -> true,
            new ItemStack(Items.WOODEN_SHOVEL), false), "an existing fuel-slot item is not permission to burn gear");
    }

    @Test
    void anUnderfundedFreshDemandDoesNotPreventRefuelingPaidInput() {
        var inventory = ironStock(new ItemStack(Items.BIRCH_PLANKS), new ItemStack(Items.STICK, 2));
        assertNull(ironPlan(inventory, 2), "a plank's leftover 100 ticks do not pay a second cold batch");
        var paid = AgentHands.ordinaryIronPlan(inventory, 2, 0, 2, fuels, slot -> true, ItemStack.EMPTY, true);
        assertEquals(1, paid.first().units());
        assertEquals(1, paid.first().count());
    }

    @Test
    void preparingWoodDoesNotPretendThatNonBurningPlanksAreFuel() {
        var inventory = ironStock(new ItemStack(Items.CRIMSON_PLANKS, 2), new ItemStack(Items.BIRCH_LOG));
        assertEquals("stick", ironPlan(inventory, 3).preparation());
        assertNull(ironPlan(ironStock(new ItemStack(Items.CRIMSON_PLANKS, 6)), 3));
        var floor = ironStock(new ItemStack(Items.BIRCH_PLANKS, 4), new ItemStack(Items.STICK, 2));
        assertNull(AgentHands.ordinaryIronPlan(floor, 1, 4, 2, fuels, slot -> true, ItemStack.EMPTY, false),
            "necessary bench materials are unavailable as fuel");
    }

    private static AgentHands.OrdinaryIronPlan ironPlan(PlayerInventory inventory, int wanted) {
        return AgentHands.ordinaryIronPlan(inventory, wanted, 0, 2, fuels, slot -> true, ItemStack.EMPTY, false);
    }

    private static PlayerInventory ironStock(ItemStack... stacks) {
        var inventory = new PlayerInventory(null);
        for (int slot = 0; slot < stacks.length; slot++) inventory.setStack(slot, stacks[slot]);
        return inventory;
    }

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
