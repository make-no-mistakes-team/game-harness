package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;

final class InventoryTriageTest {

    @Test
    void discardsJunkAndSurplusRockWhileProtectingToolsOresAndPrimaryCobblestone() {
        List<InventoryTriage.SlotInfo> slots = List.of(
            new InventoryTriage.SlotInfo(0, "stone_pickaxe", 1, true, false, false),
            new InventoryTriage.SlotInfo(1, "water_bucket", 1, true, false, false),
            new InventoryTriage.SlotInfo(2, "flint_and_steel", 1, true, false, false),
            new InventoryTriage.SlotInfo(3, "cobblestone", 64, false, false, true),
            new InventoryTriage.SlotInfo(4, "cooked_beef", 8, true, true, false),
            new InventoryTriage.SlotInfo(9, "wheat_seeds", 3, false, false, false),
            new InventoryTriage.SlotInfo(10, "rotten_flesh", 5, false, false, false),
            new InventoryTriage.SlotInfo(11, "diorite", 28, false, false, false),
            new InventoryTriage.SlotInfo(12, "cobblestone", 17, false, false, true),
            new InventoryTriage.SlotInfo(13, "cobblestone", 64, false, false, true),
            new InventoryTriage.SlotInfo(14, "raw_iron", 6, true, false, false),
            new InventoryTriage.SlotInfo(15, "diamond", 2, true, false, false)
        );

        List<Integer> drop = InventoryTriage.selectDiscardIndices(slots, "nether_portal", true, 4);
        assertEquals(4, drop.size());
        // Junk first (seeds, rotten_flesh), then redundant rock (diorite), then smallest surplus cobblestone stack!
        assertEquals(9, drop.get(0));
        assertEquals(10, drop.get(1));
        assertEquals(11, drop.get(2));
        assertEquals(12, drop.get(3));
        // Must NEVER drop primary 64-stack cobble (slot 3), tools, raw_iron, or diamonds
        assertFalse(drop.contains(0));
        assertFalse(drop.contains(1));
        assertFalse(drop.contains(2));
        assertFalse(drop.contains(3));
        assertFalse(drop.contains(14));
        assertFalse(drop.contains(15));
    }

    @Test
    void keepsOneStackOfGravelUntilFlintOrFlintAndSteelObtained() {
        List<InventoryTriage.SlotInfo> slots = List.of(
            new InventoryTriage.SlotInfo(0, "cobblestone", 64, false, false, true),
            new InventoryTriage.SlotInfo(9, "gravel", 12, false, false, false),
            new InventoryTriage.SlotInfo(10, "gravel", 40, false, false, false),
            new InventoryTriage.SlotInfo(11, "granite", 18, false, false, false)
        );

        List<Integer> needFlint = InventoryTriage.selectDiscardIndices(slots, "nether_portal", false, 3);
        assertFalse(needFlint.contains(9), "Must keep 1 stack of gravel when flint is still needed");
        assertTrue(needFlint.contains(10), "Surplus 2nd gravel stack may be dropped");
        assertTrue(needFlint.contains(11));

        List<Integer> hasFlint = InventoryTriage.selectDiscardIndices(slots, "nether_portal", true, 3);
        assertTrue(hasFlint.contains(9), "May drop gravel once flint/flint_and_steel is already owned");
        assertTrue(hasFlint.contains(10));
    }
}
