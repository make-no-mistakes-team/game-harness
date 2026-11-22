package io.gameharness.survival;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AgentSupplyEgressTest {
    private static final BlockPos REFUGE = new BlockPos(-15, 54, -34);
    private static final BlockPos LOWER = REFUGE.south().up();
    private static final BlockPos FIRST_DRY = LOWER.south().up();
    private static final BlockPos LIP = FIRST_DRY.south().up();
    private static final BlockPos APPROACH = LIP.south().up();
    private static final BlockPos OPENING = APPROACH.up();
    private static final BlockPos WATER = OPENING.up();

    @Test
    void aNewOrderAtAWalkedTreadKeepsTheOlderTurnedExit() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 5592));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.finish();
        assertTrue(egress.begin(REFUGE.east(20), true, 5930));
        egress.landed(REFUGE.east(21));
        egress.finish();
        assertTrue(egress.begin(FIRST_DRY, true, 6000));
        BlockPos newLip = FIRST_DRY.west().up();
        egress.landed(newLip);
        var retreat = egress.flood(newLip.west().up(), newLip.west().up(2), newLip.west().up(3), false, 6100);

        assertNotNull(retreat);
        assertEquals(List.of(REFUGE, LOWER, FIRST_DRY, newLip), retreat.walked());
        assertFalse(egress.active());
    }

    @Test
    void aDryLandingAtTheFirstTreadContinuesTowardTheOlderRefuge() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 5592));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.landed(LIP);
        // An earlier crossing toward this pocket may still be in memory.
        egress.landed(APPROACH);
        for (int i = 1; i <= 4; i++) egress.landed(APPROACH.south(i));
        egress.finish();
        assertTrue(egress.begin(LIP, true, 6099));
        var retreat = egress.flood(APPROACH, OPENING, WATER, true, 6100);
        assertNotNull(retreat);
        assertEquals(List.of(REFUGE, LOWER, FIRST_DRY, LIP), retreat.walked());

        var lower = retreat.afterDryLanding(FIRST_DRY);
        assertNotNull(lower);
        assertFalse(lower.outsideFlood(FIRST_DRY));
        assertEquals(List.of(REFUGE, LOWER, FIRST_DRY), lower.walked());
        assertNull(lower.afterDryLanding(FIRST_DRY), "a dry result must advance, not retry the same leg");
        var refuge = lower.afterDryLanding(LOWER);
        assertNotNull(refuge);
        assertEquals(List.of(REFUGE, LOWER), refuge.walked());
        assertTrue(refuge.outsideFlood(REFUGE));
        assertNull(refuge.afterDryLanding(REFUGE));

        assertFalse(egress.begin(FIRST_DRY, true, 6165), "foot contact is not a safe worksite");
        assertFalse(egress.begin(LOWER, true, 6165), "don't dig another shaft beside the same intrusion");
        assertTrue(egress.begin(REFUGE, true, 6200));
        assertTrue(egress.blocksFloodWork(LOWER, 6200), "a known wetward lane is not a fresh continuation");
        assertFalse(egress.blocksFloodWork(REFUGE.east().up(), 6200), "allow the sheltered alternative away from the lip");
    }

    @Test
    void aNewAdjacentStanceDoesNotInventAWalkedEdge() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 1));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.finish();

        BlockPos other = FIRST_DRY.east();
        assertTrue(egress.begin(other, true, 4));
        egress.landed(other.south().up());
        var retreat = egress.flood(null, null, null, false, 6);
        assertNotNull(retreat);
        assertEquals(List.of(other, other.south().up()), retreat.walked());
        assertFalse(retreat.outsideFlood(other), "a last remembered tread is not necessarily a refuge");
        assertNull(retreat.afterDryLanding(other), "don't drive toward unwalked neighbors");
    }

    @Test
    void floodQuarantineNeedsSpecificFreshDryEvidenceOrExpires() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(LIP, true, 6080));
        assertNull(egress.flood(APPROACH, OPENING, WATER, true, 6100), "unwalked adjacent tiles are not retreat legs");
        egress.observeBreak(OPENING);
        egress.recheckFloods(FIRST_DRY, 6165, WATER::equals);
        assertFalse(egress.begin(FIRST_DRY, true, 6165), "dry source alone does not prove the breach opening");
        egress.recheckFloods(FIRST_DRY, 6190, cell -> cell.equals(WATER) || cell.equals(OPENING));
        assertTrue(egress.begin(FIRST_DRY, true, 6190));
        assertNull(egress.flood(APPROACH, OPENING, WATER, false, 6200));
        egress.recheckFloods(FIRST_DRY, 6210, cell -> true);
        assertFalse(egress.begin(FIRST_DRY, true, 6210), "a vanished flow front may still have a live source");
        assertTrue(egress.begin(FIRST_DRY, true, 10000));
    }

    @Test
    void aNearbyExhaustedOrderCanRetryWhenTheFloodPremiseChanges() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(LIP, true, 6080));
        egress.flood(APPROACH, OPENING, WATER, true, 6100);
        assertTrue(egress.begin(REFUGE, true, 6180));
        assertTrue(egress.avoidFlood(LOWER, 6180));
        egress.refuse("no other exit", false);
        assertFalse(egress.begin(REFUGE, true, 6190));
        egress.recheckFloods(REFUGE, 6200, cell -> cell.equals(WATER) || cell.equals(OPENING));
        assertTrue(egress.begin(REFUGE, true, 6210), "temporary flood veto must not become a permanent exact refusal");
    }

    @Test
    void theReturnContainsOnlyBoundedActuallyWalkedLegsAndDropsBrokenSupports() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 1));
        for (int i = 1; i <= 120; i++) egress.landed(REFUGE.east(i));
        var retreat = egress.flood(null, null, null, false, 300);
        assertNotNull(retreat);
        assertEquals(List.of(REFUGE.east(112), REFUGE.east(113), REFUGE.east(114), REFUGE.east(115),
            REFUGE.east(116), REFUGE.east(117), REFUGE.east(118), REFUGE.east(119), REFUGE.east(120)), retreat.walked());
        assertTrue(egress.begin(REFUGE, true, 301));
        assertNull(egress.flood(null, null, null, false, 302), "unrelated old legs are evicted, not kept forever");

        egress.reset();
        assertTrue(egress.begin(REFUGE, true, 303));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.observeBreak(LOWER.down());
        assertNull(egress.flood(APPROACH, OPENING, WATER, false, 304), "don't offer a leg through a known broken support");
    }
}
