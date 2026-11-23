package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

final class AgentOrdinaryNavigatorTest {
    @Test
    void aNeutralRenderTurnKeepsTheSameInProgressEdgeAndDoesNotResetItsBounds() {
        var travel = new AgentOrdinaryNavigator.EdgeTravel();
        travel.begin(1, 1);
        travel.startMotion(new Vec3d(0.0, 1.0, 0.0));
        assertTrue(travel.keepTurn(2));
        assertTrue(travel.observe(new Vec3d(0.30, 1.0, 0.0)));
        assertFalse(travel.expired(2, 0.30));
        // No rendered input: the owner sees physical coasting, not an interposed motor.
        assertTrue(travel.keepTurn(3));
        assertTrue(travel.observe(new Vec3d(0.49, 1.0, 0.0)));
        assertFalse(travel.expired(3, 0.49));
        assertTrue(travel.keepTurn(4));
        assertTrue(travel.observe(new Vec3d(0.60, 0.92, 0.0)));
        assertTrue(travel.traversed());
        assertFalse(travel.expired(4, 0.60));
        for (int tick = 5; tick < 20; tick++) {
            assertTrue(travel.keepTurn(tick));
            assertFalse(travel.expired(tick, 0.60));
        }
        assertTrue(travel.keepTurn(20));
        assertTrue(travel.expired(20, 0.60), "renewing ownership did not renew the progress clock");
        assertFalse(travel.keepTurn(22), "an unowned body tick cannot certify this path");
    }

    @Test
    void recallLooksOnlyTowardThePredecessorOfTheActualStance() {
        var grounded = new BlockPos(-61, 72, 22);
        var predecessor = grounded.west().up();
        var untraversedSuffix = grounded.east();
        assertEquals(predecessor, AgentOrdinaryNavigator.recalledPredecessor(
            List.of(predecessor.west(), predecessor, grounded, untraversedSuffix), grounded));
        assertNull(AgentOrdinaryNavigator.recalledPredecessor(List.of(predecessor, untraversedSuffix), grounded));
    }

    @Test
    void recallDoesNotBridgeAGapADiagonalOrANonOrdinaryDrop() {
        var grounded = new BlockPos(-61, 72, 22);
        for (var invalid : List.of(grounded.west(2), grounded.north().east(), grounded.east().up(2), grounded.up())) {
            assertNull(AgentOrdinaryNavigator.recalledPredecessor(List.of(grounded.west(), invalid, grounded), grounded));
        }
        assertNull(AgentOrdinaryNavigator.recalledPredecessor(
            List.of(grounded.west(), grounded, grounded.west(2), grounded), grounded),
            "an older occurrence cannot repair the gap in the latest observed leg");
    }
}
