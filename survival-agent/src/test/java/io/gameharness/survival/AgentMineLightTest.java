package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class AgentMineLightTest {
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
        assertEquals(1, stock.charcoal(1, 0, 0));
        assertEquals(0, stock.charcoal(0, 0, 0));
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
        assertEquals(-2, beforeFuel.charcoal(2, 0, 0), "convert only the spare log");
        var withFuel = new AgentMineLight.Wood(2, 2, 2, 4, 1_200, 0);
        assertEquals(2, withFuel.charcoal(2, 0, 0));
        assertEquals(-1, withFuel.charcoal(2, 4, 4),
            "convert one spare log: eight planks pay for the bench, handles and fuel for one cook, not two");
        var noSpareLog = new AgentMineLight.Wood(1, 1, 1, 4, 1_200, 0);
        assertEquals(0, noSpareLog.charcoal(2, 4, 4), "bench planks alone cannot also pay for handles and fuel");
        var withSeparatePlanks = new AgentMineLight.Wood(2, 2, 2, 7, 1_200, 0);
        assertEquals(1, withSeparatePlanks.charcoal(2, 4, 0), "keep the replacement bench in reserve");
    }

    @Test void scarceAndMixedWoodOnlyPayForWhatCanActuallyGoInTheFurnace() {
        var scarce = new AgentMineLight.Wood(2, 2, 2, 1, 0, 1);
        assertEquals(-1, scarce.charcoal(3, 0, 0));
        var onlyCraftingWood = new AgentMineLight.Wood(4, 0, 0, 8, 1_200, 4);
        assertEquals(0, onlyCraftingWood.charcoal(3, 0, 0));
        var mixedLogs = new AgentMineLight.Wood(4, 4, 1, 4, 1_200, 4);
        assertEquals(1, mixedLogs.charcoal(3, 0, 0), "the input slot takes a single real stack");
        var protectedHandles = new AgentMineLight.Wood(1, 1, 1, 1, 300, 0);
        assertEquals(0, protectedHandles.charcoal(3, 0, 0));
    }
}
