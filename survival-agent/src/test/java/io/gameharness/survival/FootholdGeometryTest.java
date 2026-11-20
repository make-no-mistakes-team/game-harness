package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FootholdGeometryTest {
    @Test
    void canWitnessTwoSeparatedPointsBelowTheRetainedLedgeFromOrdinaryFooting() {
        var foot = new BlockPos(0, 30, 0);
        var feet = Vec3d.ofBottomCenter(foot).add(0.008, 0, -0.008);
        var ledge = new Box(foot.down());
        for (Direction bearing : Direction.Type.HORIZONTAL) {
            var cell = AgentSurfaceTread.nextFoot(foot, bearing).down();
            var low = AgentBody.footholdInterior(cell, bearing, false);
            var high = AgentBody.footholdInterior(cell, bearing, true);
            assertEquals(cell, BlockPos.ofFloored(low));
            assertEquals(cell, BlockPos.ofFloored(high));
            assertTrue(high.y - low.y >= 0.4, "independent low and high probes");

            for (double eyeHeight : new double[]{1.62, 1.27}) {
                // The action rechecks empty space after adopting its placement sneak.
                var eye = feet.add(0, eyeHeight, 0);
                assertTrue(ledge.raycast(eye, low).isEmpty(), "low ray clears the retained ledge " + bearing);
                assertTrue(ledge.raycast(eye, high).isEmpty(), "high ray clears the retained ledge " + bearing);
            }
        }
    }

    @Test
    void aFullObstructionStillInterceptsTheDescendingWitnesses() {
        var foot = new BlockPos(0, 30, 0);
        var eye = Vec3d.ofBottomCenter(foot).add(0, 1.62, 0);
        var cell = AgentSurfaceTread.nextFoot(foot, Direction.EAST).down();
        var occludingWall = new Box(cell.up());
        var occupiedCell = new Box(cell);
        for (boolean high : new boolean[]{false, true}) {
            var point = AgentBody.footholdInterior(cell, Direction.EAST, high);
            assertTrue(occludingWall.raycast(eye, point).isPresent(), "the intervening full block occludes the ray");
            assertTrue(occupiedCell.raycast(eye, point).isPresent(), "a full block in the sampled cell is hit");
        }
    }
}
