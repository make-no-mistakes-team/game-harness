package io.gameharness.survival;

import net.minecraft.block.Blocks;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentEmergencyFootwork.Action.*;
import static org.junit.jupiter.api.Assertions.*;

final class RangedEvasionTest {
    @Test
    void constrainedDodgeCountsOnlyActualCheckedMovement() {
        // Observed health drops in life two, where the player lacked a shield.
        var fire = new AgentDefense.RangedFire();
        fire.hit(8581, 90);
        fire.hit(9210, 90);
        assertFalse(fire.repeated(9210), "two widely separated impacts are not one attack sequence");
        fire.hit(9270, 90);
        assertTrue(fire.repeated(9270));
        fire.hit(9329, 90);
        assertTrue(fire.repeated(9329));

        var footwork = new AgentEmergencyFootwork();
        footwork.start(fire.away());
        var terrain = new SideLane();
        Vec3d feet = new Vec3d(-21.70, 67, -8.66);
        assertEquals(DRIVE, footwork.step(feet, -85, 45, true, false, false, terrain, Float.NaN));
        assertEquals(5, footwork.bearing());
        assertFalse(footwork.advanced(), "a dry-lane request is not movement");
        footwork.step(feet, 5, 58, true, true, false, terrain, Float.NaN);
        assertFalse(footwork.advanced(), "held input against a wall is not movement");
        footwork.step(feet.add(-0.009, 0, 0.10), 5, 58, true, true, false, terrain, Float.NaN);
        assertTrue(footwork.advanced());
        terrain.usable = false; // No new stride over a drop or through an obstruction.
        assertEquals(BRACE, footwork.step(feet, 5, 58, true, false, false, terrain, Float.NaN));
        assertNull(footwork.landing());
    }

    @Test
    void aDifferentBearingDoesNotBorrowThePriorHits() {
        var fire = new AgentDefense.RangedFire();
        fire.hit(9734, 90);
        fire.hit(9794, -90);
        assertFalse(fire.repeated(9794));
        fire.hit(9854, -90);
        assertTrue(fire.repeated(9854));
        assertFalse(fire.repeated(9955));
    }

    @Test
    void rollingRetreatCrossesManyFootfallsWithoutChangingBearingOrStoppingAtTheFirstProof() {
        var retreat = new AgentDefense.RangedRetreat();
        var feet = new Vec3d(0.5, 66, 0.5);
        var start = feet;
        var dry = new AgentVisibleHorizon.Patch(AgentVisibleHorizon.Medium.DRY, 66, 0.546, null);
        retreat.start(8896, 0, 0);
        retreat.riskAt(feet);
        var direction = retreat.walk(feet, null);
        assertFalse(retreat.sample(feet, false), "no spent key and no motion");
        assertFalse(retreat.sample(feet.add(0, 0, 0.50), false), "knockback does not earn separation");
        retreat.sample(feet, false);
        for (int i = 1; i <= 55; ++i) {
            var lane = AgentVisibleHorizon.trace((x, z) -> dry, stance(feet, 0.11, 0.135), 0, 1);
            assertEquals(AgentVisibleHorizon.Medium.DRY, lane.medium());
            assertTrue(lane.known() > lane.braking());
            assertSame(direction, retreat.walk(feet, null), "keep the rolling owner across each new proof");
            feet = feet.add(0, 0, 0.20);
            assertTrue(retreat.sample(feet, true));
            if (i == 10) assertFalse(retreat.separated(feet), "a two-block dodge is not a retreat receipt");
        }
        assertTrue(feet.distanceTo(start) >= 10);
        assertTrue(retreat.separated(feet));
    }

    @Test
    void anActualThreeBlockDropIsNotALevelLaneOrAOneGradeEscape() {
        VanillaTestResources.initialize();
        var from = new BlockPos(-64, 66, 8);
        var floor = from.south().down(4); // Its top is three blocks below the player.
        var hit = new BlockHitResult(Vec3d.ofBottomCenter(floor.up()), Direction.UP, floor, false);
        var stone = Blocks.STONE.getDefaultState();
        assertFalse(AgentBody.matchesDryRouteTop(hit, from.south().down()), "the renderer saw a different level");
        assertNull(AgentSurfaceTread.witnessedGradeEdge(from, stone, Direction.SOUTH, hit, stone, true));
        var feet = Vec3d.ofBottomCenter(from).add(0, 0, 0.05);
        var stance = stance(feet, 0.12, 0.135);
        var dry = new AgentVisibleHorizon.Patch(AgentVisibleHorizon.Medium.DRY, feet.y, 0.546, null);
        var lower = new AgentVisibleHorizon.Patch(AgentVisibleHorizon.Medium.DRY, feet.y - 3, 0.546, null);
        var lane = AgentVisibleHorizon.trace((x, z) -> z < from.getZ() + 1 ? dry : lower, stance, 0, 1);
        assertEquals(AgentVisibleHorizon.Medium.UNKNOWN, lane.medium());
        assertTrue(lane.known() < lane.braking(), "do not drive the sprint past the last safe stopping envelope");
        var retreat = new AgentDefense.RangedRetreat();
        retreat.start(10, 0, 0);
        retreat.next(18);
        assertNotEquals(0, retreat.bearing(), "a real obstruction earns a checked shoulder, not a blind stride");
    }

    private static AgentVisibleHorizon.Stance stance(Vec3d feet, double speed, double acceleration) {
        return new AgentVisibleHorizon.Stance(feet.x, feet.y, feet.z, 0.312, new Vec3d(0, 0, speed),
            acceleration, 0.546, false, BlockPos.ofFloored(feet).down());
    }

    @Test
    void visiblePressureAndImpactsBridgeKnockbackAndHandBackAfterQuiet() {
        var pressure = new AgentDefense.RangedEpisode();
        // The first played life in 87tskk resumed exposed mining before the next confirmed hit.
        int[] impacts = {1579, 1640, 1761, 1823, 1940, 2115};
        int next = 0;
        for (int tick = 1579; tick <= 2115; ++tick) {
            boolean hit = next < impacts.length && tick == impacts[next];
            if (hit) ++next;
            assertTrue(pressure.observe(tick, tick == 1579, false, hit, false, tick >= 1823, false),
                "exposed footing after a small dodge is not safety at tick " + tick);
        }
        assertFalse(pressure.observe(2315, false, false, false, false, true, false), "unseen, quiet risk expires");

        assertTrue(pressure.observe(9415, true, true, true, false, true, false));
        pressure.reset();
        assertFalse(pressure.observe(9441, false, false, false, false, true, false),
            "the old encounter does not survive respawn");
    }

    @Test
    void actualSeparationCanHandBackEarlierEvenAtLowHealth() {
        var pressure = new AgentDefense.RangedEpisode();
        assertTrue(pressure.observe(10, true, false, true, false, true, false));
        assertTrue(pressure.observe(55, false, false, false, false, true, false), "a short dodge is still exposed");
        assertTrue(pressure.observe(56, false, true, false, false, true, true), "a same-bearing shot renews concern");
        assertFalse(pressure.observe(107, false, false, false, false, true, true),
            "substantial separation and quiet hand back sooner than a timeout in place");
    }

    @Test
    void aWitnessedTrunkCanCoverActuallyReachedFootingButDirtUnderfootCannot() {
        var source = new Vec3d(0.5, 67.45, -3);
        var trunk = new Box(new BlockPos(0, 67, 0));
        var exposed = new Vec3d(1.85, 66, 1.5);
        var sheltered = new Vec3d(0.5, 66, 1.55);
        assertFalse(AgentDefense.blocksShotLine(trunk, source, exposed, false));
        assertFalse(AgentDefense.blocksShotLine(new Box(new BlockPos(0, 66, 0)), source, sheltered, true));
        assertTrue(AgentDefense.blocksShotLine(trunk, source, sheltered, false));
        var pressure = new AgentDefense.RangedEpisode();
        assertTrue(pressure.observe(1, true, false, false, false, true, false));
        assertTrue(pressure.observe(5, false, false, false, true, true, false));
        assertTrue(pressure.observe(12, false, false, true, false, true, false), "a new hit breaks the quiet cover interval");
        assertTrue(pressure.observe(15, false, false, false, true, true, false));
        assertFalse(pressure.observe(49, false, false, false, true, true, false), "settled cover can hand back earlier");
    }

    @Test
    void carriedBlocksNeedBothConfirmedHeightsAndTheBodyOnTheFarSide() {
        var from = new Vec3d(0.50, 67.42, -4);
        var lower = new BlockPos(0, 66, 0);
        var behind = new Vec3d(0.48, 66, 1.40);
        assertFalse(AgentDefense.blocksShotLine(AgentDefense.coverBox(lower, false), from, behind, false));
        assertTrue(AgentDefense.blocksShotLine(AgentDefense.coverBox(lower, true), from, behind, false));
        assertFalse(AgentDefense.blocksShotLine(AgentDefense.coverBox(lower, true), from,
            new Vec3d(0.50, 66, -1.0), false), "a wall beyond the player does not cover them");
        assertFalse(AgentDefense.blocksShotLine(AgentDefense.coverBox(lower, true), from,
            new Vec3d(1.40, 66, 1.40), false), "standing around the edge is not shelter");
    }

    @Test
    void shotSubtitlesWithoutVisualOrDamageEvidenceDoNotOwnThePlayer() {
        var pressure = new AgentDefense.RangedEpisode();
        assertFalse(pressure.observe(19, false, true, false, false, true, false));
        assertFalse(pressure.observe(30, false, true, false, true, true, false), "alone they cannot confirm shelter either");
        assertFalse(pressure.observe(80, false, false, true, false, true, false), "an old shot cannot explain an unrelated hit");
        assertFalse(pressure.observe(91, false, true, false, false, true, false));
        assertTrue(pressure.observe(93, false, false, true, false, true, false), "actual damage can corroborate a recent shot");
    }

    private static final class SideLane implements AgentEmergencyFootwork.Terrain {
        boolean usable = true;

        @Override public boolean obstructed(float bearing) { return false; }

        @Override public Vec3d dryLanding(float bearing) {
            return usable && bearing == 5 ? new Vec3d(-21.77, 67, -7.88) : null;
        }
    }
}
