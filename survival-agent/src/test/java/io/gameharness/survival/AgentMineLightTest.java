package io.gameharness.survival;

import static io.gameharness.survival.AgentMineLight.PICK_HANDLES;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class AgentMineLightTest {
    @Test void lightAndAnOptionalStoneRefitMustBothLeaveTheIronHandles() {
        var stock = new AgentMineLight.Wood(4, 4, 4, 0, 0, 2);
        int handlesForBothPicks = AgentMineLight.stoneRefitSticks(12);
        assertEquals(-3, stock.charcoal(3, 0, 0, PICK_HANDLES), "one log makes planks before the cook");
        assertEquals(-2, stock.charcoal(3, 0, 0, handlesForBothPicks),
            "a planned spare pick can keep a log instead of cooking the whole light request");
        var afterPlanks = new AgentMineLight.Wood(3, 3, 3, 4, 1_200, 2);
        assertEquals(2, afterPlanks.charcoal(3, 0, 0, handlesForBothPicks));

        // Three torch recipes turn the last two planks and two sticks into
        // thirteen torches and three sticks: enough for iron, not for both picks.
        assertEquals(3, AgentMineLight.fundedTorches(3, 1, 2, 2, 0, PICK_HANDLES, false));
        assertEquals(2, AgentMineLight.fundedTorches(3, 1, 2, 2, 0, handlesForBothPicks, false));
        assertEquals(1, AgentMineLight.fundedTorches(3, 4, 0, 3, 0, handlesForBothPicks, false),
            "use the real surplus for light if a spare pick cannot be funded anyway");
        assertFalse(AgentMineLight.fundsHandles(0, 3, handlesForBothPicks));
        assertTrue(AgentMineLight.fundsHandles(2, 3, handlesForBothPicks),
            "reserve two convertible planks or make the extra sticks before refitting");
        assertTrue(AgentMineLight.fundsHandles(0, 3, AgentMineLight.stoneRefitSticks(3)),
            "a replacement needed now can still use the scarce sticks");
    }

    @Test void emergencyLightUsesOnlyOneReservedStickWhenThereIsNoSurplus() {
        assertEquals(1, AgentMineLight.fundedTorches(3, 1, 0, 2, 0, PICK_HANDLES, true));
        assertEquals(1, AgentMineLight.fundedTorches(3, 1, 0, 1, 0, PICK_HANDLES, true),
            "light is still possible when the reserve is already short");
        assertEquals(0, AgentMineLight.fundedTorches(3, 4, 0, 2, 0, PICK_HANDLES, true));
        assertEquals(2, AgentMineLight.fundedTorches(3, 1, 2, 0, 4, PICK_HANDLES, true),
            "an emergency can defer bench wood while preserving both handles");
    }

    @Test void theNextIronAndDiamondLegsDoNotLeaveWithOnlyStartingLight() {
        int iron = AgentMineLight.tripTorches(AgentMineLight.routeSteps(61, 16));
        int diamond = AgentMineLight.tripTorches(AgentMineLight.routeSteps(61, -52));
        assertEquals(11, iron);
        assertEquals(14, diamond);
        assertEquals(2, AgentMineLight.charcoalNeeded(iron, 4, 0));
        assertEquals(3, AgentMineLight.charcoalNeeded(diamond, 4, 0));
        assertEquals(2, AgentMineLight.charcoalNeeded(diamond, 4, 1));
    }

    @Test void aShortLegNeedsOneCookAndCoalCanCoverTheWholeShortage() {
        int light = AgentMineLight.tripTorches(AgentMineLight.routeSteps(18, 16));
        assertEquals(4, light);
        assertEquals(1, AgentMineLight.charcoalNeeded(light, 2, 0));
        assertEquals(0, AgentMineLight.charcoalNeeded(light, 2, 1));
        var stock = new AgentMineLight.Wood(4, 4, 4, 3, 900, 2);
        assertEquals(1, stock.charcoal(1, 0, 0, PICK_HANDLES));
        assertEquals(0, stock.charcoal(0, 0, 0, PICK_HANDLES));
    }

    @Test void gettingBackOntoAnOldRouteStillLeavesAUsefulNewLegToSupply() {
        int light = AgentMineLight.tripTorches(2 + AgentMineLight.routeSteps(51, 16));
        assertEquals(10, light);
        assertEquals(11, AgentMineLight.tripTorches(10 + AgentMineLight.routeSteps(51, 16)),
            "charge for unlit route still ahead");
        assertEquals(2, AgentMineLight.charcoalNeeded(light, 2, 0));
        assertEquals(0, AgentMineLight.charcoalNeeded(light, 2, 2));
    }

    @Test void spareTimberCanPayForMultipleLogsWithoutSpendingHandlesOrBenchWood() {
        var beforeFuel = new AgentMineLight.Wood(3, 3, 3, 0, 0, 0);
        assertEquals(-2, beforeFuel.charcoal(2, 0, 0, PICK_HANDLES), "convert only the spare log");
        var withFuel = new AgentMineLight.Wood(2, 2, 2, 4, 1_200, 0);
        assertEquals(2, withFuel.charcoal(2, 0, 0, PICK_HANDLES));
        assertEquals(-1, withFuel.charcoal(2, 4, 4, PICK_HANDLES),
            "convert one spare log: eight planks pay for the bench, handles and fuel for one cook, not two");
        var noSpareLog = new AgentMineLight.Wood(1, 1, 1, 4, 1_200, 0);
        assertEquals(0, noSpareLog.charcoal(2, 4, 4, PICK_HANDLES), "bench planks alone cannot also pay for handles and fuel");
        var withSeparatePlanks = new AgentMineLight.Wood(2, 2, 2, 7, 1_200, 0);
        assertEquals(1, withSeparatePlanks.charcoal(2, 4, 0, PICK_HANDLES), "keep the replacement bench in reserve");
    }

    @Test void scarceAndMixedWoodOnlyPayForWhatCanActuallyGoInTheFurnace() {
        var scarce = new AgentMineLight.Wood(2, 2, 2, 1, 0, 1);
        assertEquals(-1, scarce.charcoal(3, 0, 0, PICK_HANDLES));
        var onlyCraftingWood = new AgentMineLight.Wood(4, 0, 0, 8, 1_200, 4);
        assertEquals(0, onlyCraftingWood.charcoal(3, 0, 0, PICK_HANDLES));
        var mixedLogs = new AgentMineLight.Wood(4, 4, 1, 4, 1_200, 4);
        assertEquals(1, mixedLogs.charcoal(3, 0, 0, PICK_HANDLES), "the input slot takes a single real stack");
        var protectedHandles = new AgentMineLight.Wood(1, 1, 1, 1, 300, 0);
        assertEquals(0, protectedHandles.charcoal(3, 0, 0, PICK_HANDLES));
    }
}
