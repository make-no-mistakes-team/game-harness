package io.gameharness.survival;

import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentEmergencyFootwork.Action.*;
import static org.junit.jupiter.api.Assertions.*;

final class AgentFuseEscapeTest {
    // Ordinary campaign movement samples, rounded here: the body jumps three times
    // at the same X/Z between the cue at 3747 and the explosion at 3777.
    private static final double X = -40.30, Z = 33.45;
    private static final float EAST = -90, SOUTH_ALONG_WALL = 5;
    private static final Vec3d STRAIGHT = new Vec3d(X + 0.78, 66, Z);
    private static final Vec3d SIDE = new Vec3d(X - 0.068, 66, Z + 0.777);

    @Test
    void theThreeJumpTraceRetiresTheFailedBearingBeforeTheSecondJump() {
        var escape = new AgentEmergencyFootwork();
        var terrain = new Terrain();
        escape.start(EAST);
        assertEquals(DRIVE, escape.step(feet(66), EAST, 5, true, false, false, terrain, Float.NaN));

        // Feedback from the old controller's held W: the second, third and later
        // samples are vertical only. The new controller must withdraw that request.
        assertEquals(DRIVE, escape.step(feet(66), EAST, 5, true, true, false, terrain, Float.NaN));
        escape.step(feet(66.75), EAST, 5, false, true, false, terrain, Float.NaN);
        assertEquals(ALIGN, escape.step(feet(67.17), EAST, 5, false, true, false, terrain, Float.NaN));
        assertNull(escape.landing());
        assertFalse(escape.advanced());

        terrain.side = true;
        assertEquals(DRIVE, escape.step(feet(66), EAST, 58, true, false, false, terrain, Float.NaN));
        assertEquals(SOUTH_ALONG_WALL, escape.bearing());
        assertEquals(SIDE, escape.landing());
        for (double y : new double[] {66.75, 67.17, 67.02, 66, 66.75, 67.17}) {
            escape.step(feet(y), SOUTH_ALONG_WALL, 58, y == 66, false, false, terrain, Float.NaN);
            assertEquals(SOUTH_ALONG_WALL, escape.bearing(), "do not resume the failed lane on a landing");
            assertFalse(escape.advanced(), "Y motion is not voluntary retreat");
        }
        assertEquals(BRACE, escape.step(new Vec3d(-39.63, 68.45, 33.43),
            SOUTH_ALONG_WALL, 58, false, true, true, terrain, Float.NaN));
        assertFalse(escape.advanced(), "blast knockback is not an escape effect");
        assertEquals(BRACE, escape.step(new Vec3d(-39.28, 69, 33.42),
            SOUTH_ALONG_WALL, 58, true, false, false, terrain, Float.NaN));
        assertFalse(escape.advanced(), "post-blast drift stays uncredited");
    }

    @Test
    void nearCollisionSwitchesImmediatelyButAnUnsupportedOrHazardousSideNeverDrives() {
        var escape = new AgentEmergencyFootwork();
        var terrain = new Terrain();
        terrain.wall = terrain.side = true;
        escape.start(EAST);
        assertEquals(DRIVE, escape.step(feet(66), EAST, 58, true, false, false, terrain, Float.NaN));
        assertEquals(SIDE, escape.landing());

        terrain.side = false; // The view no longer proves this short side lane (for example lava or a drop).
        assertEquals(BRACE, escape.step(feet(66), SOUTH_ALONG_WALL, 58, true, false, false, terrain, Float.NaN));
        assertNull(escape.landing());
        terrain.wall = false; // A failed bearing must not be retried on the same fuse.
        assertEquals(BRACE, escape.step(feet(66), SOUTH_ALONG_WALL, 58, true, false, false, terrain, Float.NaN));

        escape.start(EAST);
        terrain.wall = true;
        assertEquals(ALIGN, escape.step(feet(66), EAST, 5, true, false, false, terrain, Float.NaN));
        assertEquals(BRACE, escape.step(feet(66), EAST, 58, true, false, false, terrain, Float.NaN));
        assertNull(escape.landing());
    }

    @Test
    void creditsOnlyGroundedHorizontalProgressFromAnAppliedEscapeKey() {
        var escape = new AgentEmergencyFootwork();
        var terrain = new Terrain();
        escape.start(EAST);
        escape.step(feet(66), EAST, 58, true, false, false, terrain, Float.NaN);
        escape.step(feet(66).add(0.1, 0, 0), EAST, 58, true, false, false, terrain, Float.NaN);
        assertFalse(escape.advanced(), "coasting without an escape key is not an escape effect");
        escape.step(feet(66).add(0.2, 0, 0), EAST, 58, true, true, false, terrain, Float.NaN);
        assertTrue(escape.advanced());
    }

    private static Vec3d feet(double y) { return new Vec3d(X, y, Z); }

    private static final class Terrain implements AgentEmergencyFootwork.Terrain {
        boolean wall, side;

        @Override public boolean obstructed(float bearing) { return wall && bearing == EAST; }

        @Override public Vec3d dryLanding(float bearing) {
            if (bearing == EAST) return wall ? null : STRAIGHT;
            return bearing == SOUTH_ALONG_WALL && side ? SIDE : null;
        }
    }
}
