package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonParser;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.math.Box;
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
    void aHalfHeartPlayerKeepsTheHealingTurnAcrossDaysOfMisses() {
        var goal = new AgentFoodWork.HealingGoal();
        assertFalse(goal.update(16, 20, 20));
        for (int tick = 0; tick < 72_000; tick++) {
            assertTrue(goal.update(16, 0.833f, 20), "no-source and cooldown ticks must not yield to ore");
            assertFalse(goal.canRest(16));
        }
        assertTrue(goal.update(18, 0.833f, 20), "a meal is not yet a recovery");
        assertTrue(goal.canRest(18));
        assertTrue(goal.update(17, 12, 20), "falling below healing hunger resumes the food search");
        assertFalse(goal.canRest(17));
        assertFalse(goal.update(18, 14, 20), "ordinary work returns only after a safe recovery");
    }

    @Test
    void visibleAdultBeyondMeleeReachIsApproachedButNotAttackedWhileUnsafe() {
        assertEquals(AgentFoodWork.SourceAction.APPROACH, AgentFoodWork.huntAction(6 * 6, 2.8, true, true));
        assertEquals(AgentFoodWork.SourceAction.CONTACT, AgentFoodWork.huntAction(2 * 2, 2.8, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.huntAction(6 * 6, 2.8, false, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.huntAction(2 * 2, 2.8, false, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.huntAction(6 * 6, 2.8, true, false));
    }

    @Test
    void visibleGroundedDropIsApproachedUntilActualPickupOverlap() {
        var standing = new Box(-0.3, 64, -0.3, 0.3, 65.8, 0.3);
        var drop = new Box(7, 64, 0, 7.25, 64.25, 0.25);
        assertEquals(AgentFoodWork.SourceAction.APPROACH, AgentFoodWork.dropAction(standing, drop, true, true, true));
        assertEquals(AgentFoodWork.SourceAction.CONTACT,
            AgentFoodWork.dropAction(standing.offset(6, 0, 0), drop, true, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, drop, false, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, drop, true, false, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, drop, true, true, false));
    }

    @Test
    void aMealReceiptNeedsObservedConsumptionAndHungerGain() {
        assertTrue(AgentFoodWork.mealConfirmed(16, 19, 2, 1));
        assertFalse(AgentFoodWork.mealConfirmed(16, 16, 2, 1));
        assertFalse(AgentFoodWork.mealConfirmed(16, 19, 2, 2));
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
