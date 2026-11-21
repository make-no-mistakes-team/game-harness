package io.gameharness.survival;

import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentEmergencyFootwork.Action.*;
import static org.junit.jupiter.api.Assertions.*;

final class RangedEvasionTest {
    @Test
    void repeatedHitsInLifeTwoUseOnlyACheckedDodge() {
        // Life two: empty hotbar and no physical escape between these observed health drops.
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

    private static final class SideLane implements AgentEmergencyFootwork.Terrain {
        boolean usable = true;

        @Override public boolean obstructed(float bearing) { return false; }

        @Override public Vec3d dryLanding(float bearing) {
            return usable && bearing == 5 ? new Vec3d(-21.77, 67, -7.88) : null;
        }
    }
}
