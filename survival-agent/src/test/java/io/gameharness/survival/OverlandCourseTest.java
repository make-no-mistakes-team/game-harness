package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

final class OverlandCourseTest {
    @Test
    void keepsTheHorizonAfterARealDetourAndDoesNotRecycleItsFootprints() {
        var course = new AgentOverlandSearch.Course();
        var start = new BlockPos(0, 67, 0);
        course.start(start, Direction.EAST);
        assertEquals(Direction.EAST, course.bearing(0));
        assertEquals(Direction.SOUTH, course.bearing(1));

        // The eastern lane was blocked; a whole visible bypass was actually walked south.
        BlockPos foot = start;
        for (int i = 1; i <= 4; i++) {
            var next = start.south(i);
            assertTrue(course.canExtend(foot, next, Direction.SOUTH, i - 1));
            assertTrue(course.arrived(next));
            foot = next;
        }
        course.finishLeg(Direction.SOUTH);
        assertEquals(Direction.EAST, course.bearing(0));
        assertEquals(Direction.SOUTH, course.bearing(1));
        assertFalse(course.canExtend(foot, foot.north(), Direction.NORTH, 0));
        assertTrue(course.canExtend(foot, foot.east(), Direction.EAST, 0));
    }

    @Test
    void requiresConnectedFootingAndIsolatesEachHeightChange() {
        var course = new AgentOverlandSearch.Course();
        var start = new BlockPos(0, 67, 0);
        var dune = start.east().up();
        course.start(start, Direction.EAST);

        assertFalse(course.canExtend(start, start.east(2), Direction.EAST, 0));
        assertFalse(course.canExtend(start, start.east().down(2), Direction.EAST, 0));
        assertFalse(course.canExtend(start, start.east().north(), Direction.EAST, 0));
        assertFalse(course.canExtend(start, dune, Direction.EAST, 1));
        assertTrue(course.canExtend(start, dune, Direction.EAST, 0));
        assertTrue(course.arrived(dune));
        var lower = dune.east().down();
        assertTrue(course.canExtend(dune, lower, Direction.EAST, 0));
        assertTrue(course.arrived(lower));
        assertFalse(course.arrived(dune));
        assertEquals(2, course.newFootings());
    }

    @Test
    void onlyAnActualReverseLegChangesTheHorizon() {
        var course = new AgentOverlandSearch.Course();
        var start = BlockPos.ORIGIN;
        course.start(start, Direction.EAST);
        assertEquals(Direction.WEST, course.bearing(3));
        assertEquals(Direction.EAST, course.bearing(0));
        assertTrue(course.arrived(start.west()));
        course.finishLeg(Direction.WEST);
        assertEquals(Direction.WEST, course.bearing(0));
        assertFalse(course.canExtend(start.west(), start, Direction.EAST, 0));
    }

    @Test
    void anIntentionalResiteStartsASeparateCheckedCourse() {
        var course = new AgentOverlandSearch.Course();
        var start = BlockPos.ORIGIN;
        course.start(start, Direction.EAST);
        assertTrue(course.arrived(start.east()));

        course.restart(Direction.NORTH);
        course.start(start, Direction.WEST);
        assertEquals(Direction.NORTH, course.bearing(0), "the departure has a retained bearing");
        assertNull(course.previous(start), "old supply travel is not a join to the new departure");
        assertEquals(0, course.newFootings(), "a new direction did not move the actor");
        assertFalse(course.canExtend(start, start.north().down(2), Direction.NORTH, 0));
        assertTrue(course.arrived(start.north()));
        assertEquals(1, course.newFootings());
    }

    @Test
    void aCulDeSacPermitsBoundedRetracingWithoutClaimingNewTravel() {
        var course = new AgentOverlandSearch.Course();
        var start = BlockPos.ORIGIN;
        course.start(start, Direction.EAST);
        for (int i = 1; i <= 11; i++) assertTrue(course.arrived(start.east(i)));

        BlockPos foot = start.east(11);
        for (int i = 0; i < 8; i++) {
            var prior = course.previous(foot);
            assertEquals(foot.west(), prior);
            course.retraced();
            foot = prior;
        }
        assertNull(course.previous(foot));
        assertEquals(11, course.newFootings());
        assertFalse(course.canExtend(foot, foot.east(), Direction.EAST, 0));
        assertTrue(course.canExtend(foot, foot.south(), Direction.SOUTH, 0));
    }
}
