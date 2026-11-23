package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

final class DryStrideTest {
    @Test
    void holdsForwardAcrossAdjacentVerifiedTreadsThenStopsOnTheLastOne() {
        var walk = new Walk(3);
        for (int tick = 0; tick < 30; ++tick) walk.tick(true);

        assertEquals(3, walk.goal);
        assertEquals(2, walk.unbrokenHandoffs);
        assertEquals(1, walk.forwardPresses);
        assertEquals(0, walk.brakePresses);
        assertTrue(walk.position >= 2.78 && walk.position <= 3.22);
        assertFalse(walk.forward);
    }

    @Test
    void doesNotAdvancePastTheLastKnownTreadWhenTheNextOneIsUnknown() {
        var walk = new Walk(3);
        for (int tick = 0; tick < 30; ++tick) walk.tick(false);

        assertEquals(1, walk.goal);
        assertEquals(0, walk.unbrokenHandoffs);
        assertTrue(walk.position >= 0.78 && walk.position <= 1.22);
        assertFalse(walk.forward);
    }

    @Test
    void brakesOnTheCurrentSupportWhenThePreparedContinuationChanges() {
        var walk = new Walk(3);
        for (int tick = 0; tick < 8 && walk.position < 0.65; ++tick) walk.tick(true);
        assertTrue(walk.position >= 0.65, "reach the stride handoff under momentum before changing the next row");
        for (int tick = 0; tick < 30; ++tick) walk.tick(false);

        assertEquals(1, walk.goal);
        assertEquals(0, walk.unbrokenHandoffs);
        assertTrue(walk.position >= 0.78 && walk.position <= 1.22);
        assertFalse(walk.forward);
    }

    @Test
    void evenAProvedTurnOrHeightChangeIsAnEndpointForTheCurrentStride() {
        BlockPos from = new BlockPos(0, -30, 0), to = from.east();
        assertTrue(AgentSurfaceTread.straightLevelContinuation(from, to, to.east(), Direction.EAST));
        assertFalse(AgentSurfaceTread.straightLevelContinuation(from, to, to.north(), Direction.EAST));
        assertFalse(AgentSurfaceTread.straightLevelContinuation(from, to, to.east().down(), Direction.EAST));
        assertFalse(AgentSurfaceTread.straightLevelContinuation(from, to, from, Direction.EAST));
    }

    @Test
    void aFlatRetraceIncludesItsWholeBrakingSweepAndCannotUseAThirdTread() {
        var source = new BlockPos(-62, 72, 22);
        var target = source.north();
        var body = new Box(-61.8, 72, 22.2, -61.2, 73.8, 22.8);
        var back = AgentBody.ordinaryFlatSweep(source, target, body, 0, -0.10, 0.025);
        assertNotNull(back);
        assertTrue(back.minZ < target.getZ() + 1, "include the next tick and its neutral braking distance");
        assertNull(AgentBody.ordinaryFlatSweep(source, target, body, 0.10, -0.10, 0.025),
            "even a clear-looking strafe must not drift sideways out of the two treads");
        assertNull(AgentBody.ordinaryFlatSweep(source, target, body, 0, 0.10, 0),
            "residual velocity toward the original tip must not cross its outside edge");
        assertNull(AgentBody.ordinaryFlatSweep(source, target, body.offset(0, 0, -1), 0, -0.10, 0.025),
            "a second powered pulse cannot run on past the return destination");
        assertNull(AgentBody.ordinaryFlatSweep(source, target.down(), body, 0, -0.10, 0.025));
    }

    /** Feed the motor ordinary vanilla walking dynamics on a level stone lane. */
    private static final class Walk {
        private final int last;
        private int goal = 1, unbrokenHandoffs, forwardPresses, brakePresses;
        private double position, velocity;
        private boolean forward;

        private Walk(int last) { this.last = last; }

        private void tick(boolean nextVerified) {
            boolean carry = nextVerified && goal < last;
            boolean arrived = carry && AgentBody.dryStrideContact(goal - position);
            if (arrived) {
                assertTrue(forward, "a verified center crossing must not start from a key release");
                ++goal;
                carry = nextVerified && goal < last;
            }
            var input = AgentBody.dryLevelInput(goal - position, velocity, 0.546, carry);
            if (input == AgentBody.DryLevelInput.FORWARD && !forward) ++forwardPresses;
            if (input == AgentBody.DryLevelInput.BRAKE) ++brakePresses;
            forward = input == AgentBody.DryLevelInput.FORWARD;
            if (arrived && forward) ++unbrokenHandoffs;
            velocity += switch (input) {
                case FORWARD -> 0.098;
                case BRAKE -> -0.098;
                case COAST -> 0;
            };
            position += velocity;
            velocity *= 0.546;
        }
    }
}
