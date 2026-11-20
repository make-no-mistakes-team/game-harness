package io.gameharness.survival;

import java.util.Set;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FootholdGeometryTest {
    @Test
    void witnessedDryOpeningBeatsAnUpperWaterCueWithoutAuthorizingTravel() {
        var foot = new BlockPos(0, 32, 0);
        var opening = new BlockHitResult(new Vec3d(3.3, 32, 0.6), Direction.UP, new BlockPos(3, 31, 0), false);
        var upperWater = new BlockHitResult(new Vec3d(0.5, 33.6, -1.2), Direction.SOUTH, new BlockPos(0, 33, -2), false);
        var dry = new AgentMacroControl.FurnaceLook(AgentMacroControl.FurnaceCue.OPENING, opening);
        var water = new AgentMacroControl.FurnaceLook(AgentMacroControl.FurnaceCue.WATER, upperWater);
        assertEquals(dry, AgentMacroControl.FurnaceLook.prefer(water, dry));
        assertEquals(dry, AgentMacroControl.FurnaceLook.prefer(dry, water));
        assertEquals(38.0f, dry.lookPitch(new Vec3d(0.5, 33.62, 0.5)));
        assertFalse(AgentBody.drySurveyLaneCentered(foot, 0.88, 0.5, Direction.EAST),
            "the distant ground landmark supplies a bearing, not a departure or an adjacent landing");
    }

    @Test
    void workshopOffsetVetoesCrossingWithoutVetoingSameSupportSetup() {
        var foot = new BlockPos(-275, 32, -572);
        var actual = new Vec3d(-274.846, 32, -571.477); // 0.346 blocks off center in the workshop.
        var center = Vec3d.ofBottomCenter(foot);
        assertTrue(AgentBody.sameSurveySupport(foot.down(), actual));
        for (Direction bearing : Direction.Type.HORIZONTAL) {
            assertFalse(AgentBody.drySurveyLaneCentered(foot, actual.x, actual.z, bearing),
                "no cave edge may leave this stance before local setup");
            assertTrue(AgentBody.drySurveyLaneCentered(foot, center.x, center.z, bearing));
            assertFalse(AgentBody.sameSurveySupport(foot.down(), center.add(
                bearing.getOffsetX() * 0.51, 0, bearing.getOffsetZ() * 0.51)),
                "same-block positioning cannot follow the body onto the next tile");
        }
        assertFalse(AgentBody.sameSurveySupport(foot.down(), actual.add(0, -0.5, 0)));
    }

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

    @Test
    void aFlatDryShelfCanSpareOneAdjacentFloorForAStair() {
        var foot = new BlockPos(0, 30, 0);
        var east = foot.east();
        var west = foot.west();
        int eastFloor = 1 << Direction.EAST.ordinal();
        int westExit = 1 << Direction.WEST.ordinal();
        var fullTops = Set.of(foot.down(), east.down(), west.down());
        assertEquals(east.down(), AgentSurfaceTread.nextFoot(foot, Direction.EAST));
        assertTrue(fullTops.contains(foot.down()), "the player keeps their own footing");
        assertEquals(westExit, usableDryExits(foot, Set.of(foot.down(), west.down())),
            "removing the east floor leaves a genuinely walkable west exit");

        assertEquals(eastFloor, AgentSurfaceTread.spareLevelFloorChoices(eastFloor, usableDryExits(foot, fullTops), false));
        assertEquals(eastFloor, AgentSurfaceTread.spareLevelFloorChoices(eastFloor, eastFloor, true),
            "an intact walked reverse path also leaves a way out");
    }

    @Test
    void cannotCutTheOnlyDryEscapeWhenAnIntactLookingSideFloorHasABlockedSweep() {
        var foot = new BlockPos(0, 30, 0);
        var north = foot.north();
        var east = foot.east();
        var lowRoof = new Box(north.up());
        var fullTops = Set.of(foot.down(), east.down(), north.down());
        int eastFloor = 1 << Direction.EAST.ordinal();
        int usable = usableDryExits(foot, fullTops, lowRoof);
        assertEquals(eastFloor, usable, "west and south drop away; north has a top but no lane");
        assertEquals(0, usableDryExits(foot, Set.of(foot.down(), north.down()), lowRoof),
            "removing the east floor would leave no walkable exit");
        assertEquals(0, AgentSurfaceTread.spareLevelFloorChoices(eastFloor, usable, false),
            "there is also no walked way back");
    }

    private static int usableDryExits(BlockPos foot, Set<BlockPos> fullTops, Box... obstructions) {
        int exits = 0;
        for (Direction direction : Direction.Type.HORIZONTAL) {
            BlockPos to = foot.offset(direction);
            if (!fullTops.contains(to.down())) continue;
            Box sweep = AgentSurfaceTread.retainedTreadSweep(foot, to, 0.6);
            boolean blocked = false;
            for (Box obstruction : obstructions) blocked |= sweep.intersects(obstruction);
            if (!blocked) exits |= 1 << direction.ordinal();
        }
        return exits;
    }
}
