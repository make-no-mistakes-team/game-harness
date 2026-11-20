package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

final class HorizonMotionTest {
    @Test
    void oneHeldForwardInputCrossesSeveralVisibleGroundCells() {
        var walk = new Walk();
        for (int tick = 0; tick < 24; ++tick) walk.tick(1.6, 10);

        assertTrue(walk.position > 4);
        assertTrue(walk.forward);
        assertEquals(1, walk.presses);
        assertTrue(walk.motion.moved());
    }

    @Test
    void shrinkingFootprintWindowReleasesInputBeforeTheUnknownDrop() {
        var walk = new Walk();
        for (int tick = 0; tick < 32; ++tick) {
            // A person-sized stopping envelope must stop before the actual lip.
            walk.tick(Math.min(1.6, 3 - walk.position - 0.38), 10);
            assertTrue(walk.position < 2.68, "actual displacement, not the chosen goal, must stay on the lip");
        }

        assertTrue(walk.position > 2, "ordinary progress should not be frozen while ground is visible");
        assertTrue(walk.slowed);
        assertFalse(walk.forward);
        assertTrue(walk.velocity < 0.005);
    }

    @Test
    void glancesAndSubBlockCorrectionsAreNotTravelAndAContactGetsOneRecovery() {
        var motion = new AgentBody.HorizonMotion(Vec3d.ZERO, point(4));
        for (int i = 0; i < 20; ++i) {
            motion.observe(Vec3d.ZERO, Vec3d.ZERO, false, false, true);
            assertFalse(motion.moved());
            assertFalse(motion.takeRecovery());
        }
        motion.observe(Vec3d.ZERO, point(0.19), true, false, true);
        assertFalse(motion.moved());
        for (int i = 0; i < 3; ++i) motion.observe(point(0.19), point(0.19), true, true, true);
        assertTrue(motion.takeRecovery());

        for (int i = 0; i < 12; ++i) {
            motion.observe(point(0.19), point(0.19), true, true, true);
            assertFalse(motion.takeRecovery());
        }
        assertFalse(motion.moved());
    }

    @Test
    void disruptedPositionCannotBecomeTravelOnTheNextSmallMovement() {
        var motion = new AgentBody.HorizonMotion(Vec3d.ZERO, point(5));
        assertFalse(motion.observe(Vec3d.ZERO, point(2), true, false, true));
        assertFalse(motion.observe(point(2), point(2.2), true, false, true));
        assertFalse(motion.moved());
    }

    @Test
    void recenteringOverHalfABlockInTheSameCellIsNotACompletedWalk() {
        var motion = new AgentBody.HorizonMotion(point(0.15), point(4));
        motion.observe(point(0.15), point(0.4), true, false, true);
        motion.observe(point(0.4), point(0.65), true, false, true);
        motion.observe(point(0.65), point(0.88), true, false, true);
        assertFalse(motion.moved());
        motion.observe(point(0.88), point(1.08), true, false, true);
        assertTrue(motion.moved());
    }

    @Test
    void shallowTravelHoldsOwnershipOnlyWithAPositiveBrakingWindowAndDryBank() {
        var shallow = AgentVisibleHorizon.Medium.SHALLOW_WATER;
        var unknown = AgentVisibleHorizon.Medium.UNKNOWN;
        assertTrue(AgentBody.horizonWadeWindow(window(shallow, 1.75, 0.57, point(1.5))));
        assertFalse(AgentBody.horizonWadeWindow(window(shallow, 1.75, 0.57, null)));
        assertFalse(AgentBody.horizonWadeWindow(window(shallow, 0.48, 0.57, point(1.5))));
        assertFalse(AgentBody.horizonWadeWindow(window(unknown, 1.75, 0.57, point(1.5))));
    }

    @Test
    void contactOnlyPrefixUsesOrdinaryInputAndCoastsWhenTheMarginVanishes() {
        assertEquals(AgentBody.HorizonPace.WALK, AgentBody.horizonPace(0.39, 0.37, 5, false, true));
        assertEquals(AgentBody.HorizonPace.COAST, AgentBody.horizonPace(0.32, 0.37, 5, false, true));
    }

    @Test
    void opticalTravelWinsThenOneAuthorizedPulseCanCoastIntoNewOpticalSupport() {
        var pulse = new AgentVisibleHorizon.ContactPulse();
        var dry = AgentVisibleHorizon.Medium.DRY;
        var optical = window(dry, 1.12, 0.30, null);
        var contact = new AgentVisibleHorizon.Window(null, -90, 0.34, 0.30,
            dry, 1, 0, 0, null, true);

        assertSame(optical, pulse.choose(optical, contact, -90, Float.NaN,
            (candidate, yaw, allowWade) -> { throw new AssertionError("don't probe contact when optical can advance"); }));
        assertSame(contact, pulse.choose(null, contact, -90, Float.NaN, (candidate, yaw, allowWade) -> candidate));
        pulse.markIssued(contact.frame());
        assertTrue(pulse.used());
        assertFalse(pulse.canJoin(contact.frame()));
        assertTrue(pulse.canJoin(contact.frame() + 1));
        for (int frame = 2; frame < 8; ++frame)
            assertNull(pulse.choose(null, contact, -90, Float.NaN, (candidate, yaw, allowWade) -> candidate));
        assertSame(optical, pulse.choose(optical, contact, -90, Float.NaN, (candidate, yaw, allowWade) -> candidate));
    }

    private static AgentVisibleHorizon.Window window(AgentVisibleHorizon.Medium medium,
                                                       double known, double braking, Vec3d dryBank) {
        return new AgentVisibleHorizon.Window(null, 0, known, braking, medium, 1, 0, 0, dryBank, false);
    }

    private static Vec3d point(double x) { return new Vec3d(x, 0, 0); }

    /** Same post-friction velocity recurrence as normal vanilla stone-floor input, without a game fixture. */
    private static final class Walk {
        final AgentBody.HorizonMotion motion = new AgentBody.HorizonMotion(Vec3d.ZERO, point(10));
        double position, velocity;
        int presses;
        boolean forward, slowed;

        void tick(double known, double goal) {
            double braking = (velocity + 0.098) / (1 - 0.546) + 0.075;
            var pace = AgentBody.horizonPace(known, braking, goal - position, false, false);
            double acceleration = switch (pace) {
                case WALK -> 0.098;
                case SLOW -> 0.0294;
                case COAST -> 0;
            };
            if (pace == AgentBody.HorizonPace.SLOW) slowed = true;
            boolean pressed = acceleration > 0;
            if (pressed && !forward) ++presses;
            forward = pressed;
            Vec3d before = point(position);
            velocity += acceleration;
            position += velocity;
            velocity *= 0.546;
            motion.observe(before, point(position), pressed, false, true);
        }
    }
}
