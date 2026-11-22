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
    void aCheckedFirstDodgeDoesNotEndTheRetreatWhenTheStraightTreadRunsOut() {
        var retreat = new AgentDefense.RangedRetreat();
        var terrain = new Shoulder();
        var feet = new Vec3d(-63.73, 66, 8.68);
        retreat.start(8896, 0, 0);
        assertEquals(DRIVE, retreat.step(8903, feet, 0, 58, false, terrain));
        feet = feet.add(0, 0, 0.22);
        assertEquals(DRIVE, retreat.step(8908, feet, 0, 58, true, terrain));
        assertTrue(retreat.advanced(), "applied input and actual grounded displacement");

        terrain.straight = false;
        assertEquals(ALIGN, retreat.step(8911, feet, 0, 58, false, terrain));
        assertEquals(ALIGN, retreat.step(8912, feet, 0, 58, false, terrain));
        assertNull(retreat.landing(), "no continued input over the end of the first tread");
        float shoulder = retreat.bearing();
        assertNotEquals(0, shoulder);
        assertEquals(DRIVE, retreat.step(8914, feet, shoulder, 58, false, terrain));
        assertFalse(retreat.advanced(), "finding a new lane is not another dodge");
        assertEquals(DRIVE, retreat.step(8915, feet.add(Vec3d.fromPolar(0, shoulder).multiply(0.14)),
            shoulder, 58, true, terrain));
        assertTrue(retreat.advanced());
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
        var retreat = new AgentDefense.RangedRetreat();
        var terrain = new Shoulder();
        terrain.straight = terrain.side = false;
        retreat.start(10, 0, 0);
        for (int tick = 11; tick < 35; tick++) {
            assertNotEquals(DRIVE, retreat.step(tick, Vec3d.ofBottomCenter(from), retreat.bearing(), 58,
                false, terrain));
            assertNull(retreat.landing());
        }
    }

    @Test
    void visiblePressureAndImpactsBridgeKnockbackAndHandBackAfterQuiet() {
        var pressure = new AgentDefense.RangedEpisode();
        assertTrue(pressure.observe(8881, true, false, false, false));
        assertTrue(pressure.observe(8885, false, true, true, false));
        for (int tick = 8886; tick < 8944; tick++)
            assertTrue(pressure.observe(tick, false, tick == 8940, false, false), "no mining between shots");
        assertTrue(pressure.observe(8944, false, false, true, false));
        assertTrue(pressure.observe(9007, false, false, true, false));
        assertFalse(pressure.observe(9110, false, false, false, false), "stale evidence expires");

        assertTrue(pressure.observe(9415, true, true, true, false));
        pressure.reset();
        assertFalse(pressure.observe(9441, false, false, false, false), "the old encounter does not survive respawn");
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
        assertTrue(pressure.observe(1, true, false, false, false));
        assertTrue(pressure.observe(5, false, false, false, true));
        assertTrue(pressure.observe(12, false, false, true, false), "a new hit breaks the quiet cover interval");
        assertTrue(pressure.observe(15, false, false, false, true));
        assertFalse(pressure.observe(34, false, false, false, true), "settled cover can hand back earlier");
    }

    @Test
    void shotSubtitlesWithoutVisualOrDamageEvidenceDoNotOwnThePlayer() {
        var pressure = new AgentDefense.RangedEpisode();
        assertFalse(pressure.observe(19, false, true, false, false));
        assertFalse(pressure.observe(30, false, true, false, true), "alone they cannot confirm shelter either");
        assertFalse(pressure.observe(80, false, false, true, false), "an old shot cannot explain an unrelated hit");
        assertFalse(pressure.observe(91, false, true, false, false));
        assertTrue(pressure.observe(93, false, false, true, false), "actual damage can corroborate a recent shot");
    }

    private static final class Shoulder implements AgentEmergencyFootwork.Terrain {
        boolean straight = true, side = true;

        @Override public boolean obstructed(float bearing) { return false; }

        @Override public Vec3d dryLanding(float bearing) {
            return (bearing == 0 ? straight : side) ? Vec3d.fromPolar(0, bearing).multiply(1.8) : null;
        }
    }

    private static final class SideLane implements AgentEmergencyFootwork.Terrain {
        boolean usable = true;

        @Override public boolean obstructed(float bearing) { return false; }

        @Override public Vec3d dryLanding(float bearing) {
            return usable && bearing == 5 ? new Vec3d(-21.77, 67, -7.88) : null;
        }
    }
}
