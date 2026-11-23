package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class AgentOrdinaryNavigatorTest {
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
