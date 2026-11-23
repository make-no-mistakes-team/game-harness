package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonParser;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class AgentFoodWorkTest {
    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void exactFoodWorkCannotSpendOrRenew() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"meal","run":"run","life":1,"epoch":1,"basisTick":10,"expiresTick":120,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:porkchop","count":1},
             "allowedEffects":["forage:entity:minecraft:pig"],
             "maxBreaks":0,"maxCrafts":0,"maxPlacements":0,"costCaps":[],"reserves":[]}
            """).getAsJsonObject();
        var order = AgentWorkOrder.parse(raw, "run", "constrained");
        assertEquals(AgentFoodWork.Source.PIG, order.policy().foodSource());
        assertFalse(order.policy().pendingOrdinary());
        var extended = raw.deepCopy();
        extended.addProperty("expiresTick", 150);
        assertFalse(AgentMacroControl.canRenewWork(order, order, AgentWorkOrder.parse(extended, "run", "constrained")));
        var spends = raw.deepCopy();
        spends.add("costCaps", JsonParser.parseString("[{\"item\":\"minecraft:wooden_axe\",\"count\":1}]"));
        assertNull(AgentWorkOrder.parse(spends, "run", "constrained").policy());
        raw.getAsJsonObject("target").addProperty("item", "minecraft:beef");
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy());
    }

    @Test
    void contactRequiresRipeFoodAndAnAxeThatCannotBreakOnTheNextHit() {
        var bush = Blocks.SWEET_BERRY_BUSH.getDefaultState();
        assertNull(AgentFoodWork.ripe(bush.with(SweetBerryBushBlock.AGE, 1)));
        assertEquals(AgentFoodWork.Source.SWEET_BERRIES, AgentFoodWork.ripe(bush.with(SweetBerryBushBlock.AGE, 2)));
        var vines = Blocks.CAVE_VINES_PLANT.getDefaultState();
        assertNull(AgentFoodWork.ripe(vines.with(CaveVines.BERRIES, false)));
        assertEquals(AgentFoodWork.Source.GLOW_PLANT, AgentFoodWork.ripe(vines.with(CaveVines.BERRIES, true)));
        assertFalse(AgentFoodWork.safeWeapon(new ItemStack(Items.WOODEN_PICKAXE)));
        assertFalse(AgentFoodWork.safeWeapon(new ItemStack(Items.WOODEN_SWORD)), "sweeps are not exact contacts");
        var axe = new ItemStack(Items.WOODEN_AXE);
        axe.setDamage(axe.getMaxDamage() - 3);
        assertTrue(AgentFoodWork.safeWeapon(axe));
        axe.setDamage(axe.getMaxDamage() - 2);
        assertFalse(AgentFoodWork.safeWeapon(axe));
    }

    @Test
    void aWitnessedPickupDeltaIsNotAStoredStockPromiseAfterEating() {
        assertEquals(2, AgentFoodWork.pickupGain(0, 2, true, false));
        assertEquals(0, AgentFoodWork.pickupGain(0, 2, false, false));
        assertEquals(2, AgentFoodWork.pickupGain(0, 2, false, true));
        assertEquals(0, AgentFoodWork.pickupGain(2, 1, true, true), "a later meal is not additional loot");
    }

    @Test
    void aCriticallyWoundedPlayerBelowHealingHungerCanPauseABlockedRouteOnSafeFooting() {
        assertTrue(AgentFoodWork.canPauseRoute(17, false, AgentFoodWork.criticalForage(17, 0.833f, true)));
        assertFalse(AgentFoodWork.canPauseRoute(17, false, AgentFoodWork.criticalForage(17, 0.833f, false)));
        assertFalse(AgentFoodWork.canPauseRoute(17, true, AgentFoodWork.criticalForage(17, 20, true)));
        assertFalse(AgentFoodWork.canPauseRoute(18, false, AgentFoodWork.criticalForage(18, 0.833f, true)));
        assertTrue(AgentFoodWork.canPauseRoute(10, true, AgentFoodWork.criticalForage(10, 20, true)));
        assertFalse(AgentFoodWork.canPauseRoute(10, false, AgentFoodWork.criticalForage(10, 20, true)));
    }

    @Test
    void aRiskyMealIsLimitedToActualRottenFlesh() {
        var flesh = new ItemStack(Items.ROTTEN_FLESH, 2);
        assertFalse(AgentFoodWork.safeMeal(flesh));
        assertTrue(AgentFoodWork.fleshMeal(flesh));
        assertTrue(AgentFoodWork.safeMeal(new ItemStack(Items.SWEET_BERRIES)));
        for (var item : new net.minecraft.item.Item[] {Items.SPIDER_EYE, Items.POISONOUS_POTATO,
                Items.PUFFERFISH, Items.CHICKEN, Items.SUSPICIOUS_STEW, Items.CHORUS_FRUIT, Items.DIRT}) {
            var stack = new ItemStack(item);
            assertFalse(AgentFoodWork.safeMeal(stack));
            assertFalse(AgentFoodWork.fleshMeal(stack));
        }
        assertFalse(AgentFoodWork.fleshMeal(ItemStack.EMPTY));
    }

    @Test
    void anExactDropReceiptRequiresBothMatchingStockGainAndWitnessedDepletion() {
        assertEquals(1, AgentFoodWork.ordinaryPickupGain(0, 1, 3, 2));
        assertEquals(2, AgentFoodWork.ordinaryPickupGain(0, 3, 2, 0), "never count more than the sighting held");
        assertEquals(0, AgentFoodWork.ordinaryPickupGain(0, 2, 3, 3), "unrelated gain is not the sighted drop");
        assertEquals(0, AgentFoodWork.ordinaryPickupGain(1, 1, 2, 0), "a vanishing drop is not a pickup");
    }

    @Test
    void anImprovisedHuntCanUseAWoodenPickButCannotBreakItOrChase() {
        var pick = new ItemStack(Items.WOODEN_PICKAXE);
        assertTrue(AgentFoodWork.improvisedWeapon(pick));
        pick.setDamage(pick.getMaxDamage() - 2);
        assertFalse(AgentFoodWork.improvisedWeapon(pick));
        assertFalse(AgentFoodWork.improvisedWeapon(ItemStack.EMPTY));
        assertFalse(AgentFoodWork.improvisedWeapon(new ItemStack(Items.STICK)));
        assertTrue(AgentFoodWork.criticalHuntContact(6, 2.8, true));
        assertFalse(AgentFoodWork.criticalHuntContact(9, 2.8, true));
        assertFalse(AgentFoodWork.criticalHuntContact(6, 2.8, false));
    }
}
