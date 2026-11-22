package io.gameharness.survival;

import static io.gameharness.survival.AgentHands.WorkCraftStep.BENCH;
import static io.gameharness.survival.AgentHands.WorkCraftStep.CRAFT;
import static io.gameharness.survival.AgentHands.WorkCraftStep.INPUTS;
import static io.gameharness.survival.AgentHands.WorkCraftStep.OUTSIDE_GRANT;
import static io.gameharness.survival.AgentHands.WorkCraftStep.STORAGE;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class AgentStockRecipeTest {
    @Test void optionalToolsCannotDelayAnAffordableFirstPick() {
        // Two logs and two sticks already cover a table and pick. No optional tool fits.
        assertEquals(AgentProgress.PickExtras.NONE,
            AgentProgress.PickExtras.choose(true, 1, 2 * 4 - 4 - 3, 2, true, true));
        // With three logs and three sticks, adding the axe would require one extra plank.
        assertEquals(AgentProgress.PickExtras.SHOVEL,
            AgentProgress.PickExtras.choose(true, 5, 3 * 4 - 4 - 3, 3, true, true));
        assertEquals(AgentProgress.PickExtras.BOTH,
            AgentProgress.PickExtras.choose(true, 9, 4 * 4 - 4 - 3, 2, true, true));
        // Wood alone cannot fund a stone axe after the stone pick and shovel are accounted for.
        assertEquals(AgentProgress.PickExtras.SHOVEL,
            AgentProgress.PickExtras.choose(false, 3, 12, 6, true, true));
    }

    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void suppliedStonePickUsesBenchPreparationWithoutBreakPermission() {
        var inventory = new PlayerInventory(null);
        inventory.setStack(1, new ItemStack(Items.COBBLESTONE, 3));
        inventory.setStack(2, new ItemStack(Items.CRAFTING_TABLE));
        inventory.setStack(20, new ItemStack(Items.STICK, 2));
        var budget = budget("stone_pickaxe", Items.STONE_PICKAXE,
            Map.of(Items.COBBLESTONE, 3, Items.STICK, 2), Map.of());

        assertEquals(BENCH, AgentHands.workCraftStatus(inventory, "stone_pickaxe", budget, false).step());
        assertEquals(CRAFT, AgentHands.workCraftStatus(inventory, "stone_pickaxe", budget, true).step());
        assertFalse(budget.canBreak());
        assertEquals(1, budget.placementsLeft());
        assertEquals(1, budget.craftsLeft());
    }

    @Test
    void reserveAndCostLimitedStoneReportsARealCompatibleInputShortfall() {
        var inventory = new PlayerInventory(null);
        inventory.setStack(1, new ItemStack(Items.COBBLESTONE, 3));
        inventory.setStack(20, new ItemStack(Items.STICK, 2));
        var budget = budget("stone_pickaxe", Items.STONE_PICKAXE,
            Map.of(Items.COBBLESTONE, 3, Items.BLACKSTONE, 1, Items.STICK, 2), Map.of(Items.COBBLESTONE, 1));

        var unavailable = AgentHands.workCraftStatus(inventory, "stone_pickaxe", budget, false);
        assertEquals(INPUTS, unavailable.step());
        assertEquals(1, unavailable.need().count());
        assertTrue(unavailable.need().matches(new ItemStack(Items.BLACKSTONE)));
        assertFalse(unavailable.need().matches(new ItemStack(Items.STONE)));
        inventory.setStack(7, new ItemStack(Items.BLACKSTONE));
        assertEquals(BENCH, AgentHands.workCraftStatus(inventory, "stone_pickaxe", budget, false).step());
        var lowerCap = budget("stone_pickaxe", Items.STONE_PICKAXE,
            Map.of(Items.COBBLESTONE, 1, Items.BLACKSTONE, 1, Items.STICK, 2), Map.of(Items.COBBLESTONE, 1));
        var capped = AgentHands.workCraftStatus(inventory, "stone_pickaxe", lowerCap, true);
        assertEquals(INPUTS, capped.step());
        assertEquals(1, capped.need().count());
    }

    @Test
    void mixedPlanksRemainValidForBenchRecipes() {
        var inventory = new PlayerInventory(null);
        inventory.setStack(2, new ItemStack(Items.OAK_PLANKS));
        inventory.setStack(9, new ItemStack(Items.BIRCH_PLANKS, 2));
        inventory.setStack(20, new ItemStack(Items.STICK, 2));
        var budget = budget("wooden_pickaxe", Items.WOODEN_PICKAXE,
            Map.of(Items.OAK_PLANKS, 1, Items.BIRCH_PLANKS, 2, Items.STICK, 2), Map.of());

        assertEquals(BENCH, AgentHands.workCraftStatus(inventory, "wooden_pickaxe", budget, false).step());
        assertEquals(CRAFT, AgentHands.workCraftStatus(inventory, "wooden_pickaxe", budget, true).step());
    }

    @Test
    void storageAndSpentCraftsAreNotIngredientShortages() {
        var inventory = new PlayerInventory(null);
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot)
            inventory.setStack(slot, new ItemStack(Items.DIRT, 64));
        inventory.setStack(1, new ItemStack(Items.COBBLESTONE, 64));
        inventory.setStack(2, new ItemStack(Items.STICK, 64));
        var budget = budget("stone_pickaxe", Items.STONE_PICKAXE,
            Map.of(Items.COBBLESTONE, 3, Items.STICK, 2), Map.of());

        assertEquals(STORAGE, AgentHands.workCraftStatus(inventory, "stone_pickaxe", budget, false).step());
        budget.crafted(Map.of(Items.COBBLESTONE, 3, Items.STICK, 2), 1);
        assertEquals(OUTSIDE_GRANT, AgentHands.workCraftStatus(inventory, "stone_pickaxe", budget, true).step());
    }

    private static AgentWorkOrder.Budget budget(String recipe, Item result, Map<Item, Integer> ingredients,
                                               Map<Item, Integer> reserves) {
        var caps = new HashMap<>(ingredients);
        caps.put(Items.CRAFTING_TABLE, 1);
        return new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(result, 1, null),
            Set.of("craft:" + recipe, "place:minecraft:crafting_table"), Map.copyOf(caps), reserves, 0, 1, 1));
    }
}
