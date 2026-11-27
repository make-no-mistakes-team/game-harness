package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

final class SafeDescentTest {

    private static SafeDescent.AssessmentInput baseClearDrop() {
        return new SafeDescent.AssessmentInput(
            24,     // dropDepth
            true,   // floorObserved
            false,  // landingLava
            false,  // landingHazard
            false,  // landingWater
            true,   // landingSolidDry
            0,      // landingHostiles
            true,   // hasCliffWall
            false,  // hasSteppedShelf
            true,   // hasWaterBucket
            false,  // hasBoat
            false,  // canCraftBoat
            true,   // hasPickaxe
            24,     // scaffoldBlocks
            20.0f,  // health
            true    // wantDescend
        );
    }

    @Test
    void trivialDropRequiresNoSpecialManeuver() {
        var in = new SafeDescent.AssessmentInput(
            3, true, false, false, false, true, 0, true, false, true, true, false, true, 32, 20f, true);
        var dec = SafeDescent.evaluateBestMethod(in, SafeDescent.Method.AUTO);
        assertFalse(dec.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, dec.method());
    }

    @Test
    void lavaPitRefusesDirectJumpEvenWhenWaterClutchOrBoatRequested() {
        var lavaIn = new SafeDescent.AssessmentInput(
            22, true, true, false, false, false, 0, true, false, true, true, false, true, 32, 20f, true);

        var autoDec = SafeDescent.evaluateBestMethod(lavaIn, SafeDescent.Method.AUTO);
        assertFalse(autoDec.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, autoDec.method());
        assertEquals("lava_landing", autoDec.refusedReason());

        var clutchDec = SafeDescent.evaluateBestMethod(lavaIn, SafeDescent.Method.WATER_CLUTCH);
        assertFalse(clutchDec.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, clutchDec.method());
        assertEquals("lava_landing", clutchDec.refusedReason());

        var boatDec = SafeDescent.evaluateBestMethod(lavaIn, SafeDescent.Method.BOAT_DROP);
        assertFalse(boatDec.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, boatDec.method());
        assertEquals("lava_landing", boatDec.refusedReason());

        // Explicit cliff stair away from lava is allowed when cliff wall + pickaxe exist, while still recording lava_landing
        var stairDec = SafeDescent.evaluateBestMethod(lavaIn, SafeDescent.Method.CLIFF_STAIR);
        assertTrue(stairDec.shouldDescend());
        assertEquals(SafeDescent.Method.CLIFF_STAIR, stairDec.method());
        assertEquals("lava_landing", stairDec.refusedReason());
    }

    @Test
    void unseenFloorRefusesBlindClutchAndBoatJump() {
        var darkDropWithWater = new SafeDescent.AssessmentInput(
            20, false, false, false, false, false, 0, true, false, true, true, false, true, 24, 20f, true);
        // With water bucket, unseen floor prefers safe waterfall pour instead of blind MLG jump!
        var decWater = SafeDescent.evaluateBestMethod(darkDropWithWater, SafeDescent.Method.AUTO);
        assertTrue(decWater.shouldDescend());
        assertEquals(SafeDescent.Method.WATER_POUR, decWater.method());

        // Even if caller explicitly asked for WATER_CLUTCH on an unseen floor, never blind-jump!
        var decForcedClutch = SafeDescent.evaluateBestMethod(darkDropWithWater, SafeDescent.Method.WATER_CLUTCH);
        assertNotEquals(SafeDescent.Method.WATER_CLUTCH, decForcedClutch.method());
        assertFalse(decForcedClutch.shouldDescend());
        assertEquals("unseen_floor", decForcedClutch.refusedReason());

        // Without water bucket, unseen floor with cliff wall + pickaxe chooses sheltered cliff staircase!
        var darkNoWater = new SafeDescent.AssessmentInput(
            20, false, false, false, false, false, 0, true, false, false, true, false, true, 24, 20f, true);
        var decStair = SafeDescent.evaluateBestMethod(darkNoWater, SafeDescent.Method.AUTO);
        assertTrue(decStair.shouldDescend());
        assertEquals(SafeDescent.Method.CLIFF_STAIR, decStair.method());
    }

    @Test
    void autoSelectionChoosesOptimalMethodForAvailableGear() {
        // 1. Water bucket + clear dry deep floor + healthy -> WATER_CLUTCH
        var dec1 = SafeDescent.evaluateBestMethod(baseClearDrop(), SafeDescent.Method.AUTO);
        assertTrue(dec1.shouldDescend());
        assertEquals(SafeDescent.Method.WATER_CLUTCH, dec1.method());

        // 2. Boat carried (no water bucket) + clear dry floor -> BOAT_DROP
        var boatIn = new SafeDescent.AssessmentInput(
            24, true, false, false, false, true, 0, true, false, false, true, false, true, 16, 20f, true);
        var dec2 = SafeDescent.evaluateBestMethod(boatIn, SafeDescent.Method.AUTO);
        assertTrue(dec2.shouldDescend());
        assertEquals(SafeDescent.Method.BOAT_DROP, dec2.method());

        // 3. Stepped shelf + scaffolds (no water/boat) -> EDGE_BLOCKS
        var edgeIn = new SafeDescent.AssessmentInput(
            12, true, false, false, false, true, 0, true, true, false, false, false, true, 32, 20f, true);
        var dec3 = SafeDescent.evaluateBestMethod(edgeIn, SafeDescent.Method.AUTO);
        assertTrue(dec3.shouldDescend());
        assertEquals(SafeDescent.Method.EDGE_BLOCKS, dec3.method());

        // 4. Cliff wall + pickaxe (no water/boat/stepped shelf) -> CLIFF_STAIR
        var stairIn = new SafeDescent.AssessmentInput(
            18, true, false, false, false, true, 0, true, false, false, false, false, true, 24, 20f, true);
        var dec4 = SafeDescent.evaluateBestMethod(stairIn, SafeDescent.Method.AUTO);
        assertTrue(dec4.shouldDescend());
        assertEquals(SafeDescent.Method.CLIFF_STAIR, dec4.method());

        // 5. No gear at all -> AVOID with insufficient_gear
        var bareIn = new SafeDescent.AssessmentInput(
            20, true, false, false, false, true, 0, false, false, false, false, false, false, 0, 20f, true);
        var dec5 = SafeDescent.evaluateBestMethod(bareIn, SafeDescent.Method.AUTO);
        assertFalse(dec5.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, dec5.method());
        assertEquals("insufficient_gear", dec5.refusedReason());
    }

    @Test
    void lowHpHostileSwarmRefusesOpenJump() {
        var swarmIn = new SafeDescent.AssessmentInput(
            20, true, false, false, false, true, 3, true, false, true, true, false, true, 24, 9.0f, true);
        var decClutch = SafeDescent.evaluateBestMethod(swarmIn, SafeDescent.Method.WATER_CLUTCH);
        assertFalse(decClutch.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, decClutch.method());
        assertEquals("hostile_swarm_low_hp", decClutch.refusedReason());
    }

    @Test
    void explicitSafeOverridesAreHonoredAndMethodParsingWorks() {
        var decPour = SafeDescent.evaluateBestMethod(baseClearDrop(), SafeDescent.Method.WATER_POUR);
        assertTrue(decPour.shouldDescend());
        assertEquals(SafeDescent.Method.WATER_POUR, decPour.method());

        var decAvoid = SafeDescent.evaluateBestMethod(baseClearDrop(), SafeDescent.Method.AVOID);
        assertFalse(decAvoid.shouldDescend());
        assertEquals(SafeDescent.Method.AVOID, decAvoid.method());

        assertEquals(SafeDescent.Method.WATER_CLUTCH, SafeDescent.Method.parse("water_clutch"));
        assertEquals(SafeDescent.Method.WATER_POUR, SafeDescent.Method.parse("waterfall"));
        assertEquals(SafeDescent.Method.BOAT_DROP, SafeDescent.Method.parse("boat_drop"));
        assertEquals(SafeDescent.Method.CLIFF_STAIR, SafeDescent.Method.parse("cliff_stair"));
        assertEquals(SafeDescent.Method.EDGE_BLOCKS, SafeDescent.Method.parse("edge_blocks"));
        assertEquals(SafeDescent.Method.AVOID, SafeDescent.Method.parse("avoid"));
        assertEquals(SafeDescent.Method.AUTO, SafeDescent.Method.parse("auto"));
    }
}
