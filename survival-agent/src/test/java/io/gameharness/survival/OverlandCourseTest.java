package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

final class OverlandCourseTest {
    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

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
    void lowerBirchNeedsAFlatLeadInAndAWitnessedDescentBeforeChopping() {
        var feet = new Vec3d(-34.52, 65, 6.38);
        var trunk = new BlockPos(-31, 64, 4);
        var face = new Vec3d(-31, 64.8, 4.7);
        var goal = AgentProgress.timberCollectionGoal(feet, trunk, face, 0.6);
        var course = new AgentOverlandSearch.Course();
        var start = BlockPos.ofFloored(feet);
        var first = start.east();
        var lip = first.east();
        var lower = lip.east().down();
        var approach = lower.north();
        var stance = approach.north();
        course.start(start, Direction.EAST);

        assertFalse(goal.reached(feet), "the t20610 trunk is in reach, but its drop is not");
        assertTrue(course.offerResource(start, first, Direction.EAST, 0, goal, foot -> foot.equals(first)));
        assertTrue(course.offerResource(first, lip, Direction.EAST, 1, goal, foot -> foot.equals(lip)));
        assertTrue(course.arrived(first));
        assertTrue(course.arrived(lip));
        assertFalse(course.offerResource(lip, lower, Direction.EAST, 2, goal, foot -> true),
            "a grade may not be appended to a rolling flat leg");
        assertFalse(course.offerResource(lip, lower, Direction.EAST, 0, goal, foot -> false),
            "a clipped or unsupported landing does not become a route");
        assertTrue(course.offerResource(lip, lower, Direction.EAST, 0, goal, foot -> foot.equals(lower)));
        assertTrue(course.arrived(lower));
        assertTrue(course.offerResource(lower, approach, Direction.NORTH, 0, goal, foot -> foot.equals(approach)));
        assertTrue(course.offerResource(approach, stance, Direction.NORTH, 1, goal, foot -> foot.equals(stance)));
        assertTrue(goal.reached(Vec3d.ofBottomCenter(stance)));
        assertFalse(goal.reached(Vec3d.ofBottomCenter(stance.up())), "standing directly above the site is not pickup access");

        var player = new Box(-34.82, 65, 6.08, -34.22, 66.8, 6.68);
        var drop = new Box(-30.98, 64, 4.25, -30.73, 64.25, 4.50);
        var stock = AgentPickup.logApproach(player, drop);
        assertNotNull(stock);
        assertFalse(stock.reached(Vec3d.ofBottomCenter(stance.up())));
        assertTrue(course.offerResource(lower, approach, Direction.NORTH, 0, stock, foot -> true));
        assertTrue(course.offerResource(approach, stance, Direction.NORTH, 1, stock, foot -> true));
        assertTrue(stock.reached(Vec3d.ofBottomCenter(stance)));
    }

    @Test
    void flatOakAndItsGroundedDropNeedMoreThanOneShortApproach() {
        var feet = new Vec3d(-34.52, 65, 6.38);
        var trunk = new BlockPos(-33, 65, 9);
        var first = BlockPos.ofFloored(feet).south();
        var second = first.south();
        var stance = second.east();
        var goal = AgentProgress.timberCollectionGoal(feet, trunk, new Vec3d(-32.9, 65.5, 9), 0.6);
        var course = new AgentOverlandSearch.Course();
        course.start(BlockPos.ofFloored(feet), Direction.SOUTH);
        assertFalse(goal.reached(feet), "the t20774 reach is not a useful collection stance");
        assertFalse(goal.reached(Vec3d.ofBottomCenter(first)));
        assertTrue(goal.reached(Vec3d.ofBottomCenter(stance)));

        var drop = new Box(-32.96, 65, 9.17, -32.71, 65.25, 9.42);
        var player = new Box(-34.82, 65, 6.08, -34.22, 66.8, 6.68);
        var pickup = new AgentPickup.Pursuit(100, 0, feet, drop, true, true);
        var stock = AgentPickup.logApproach(player, pickup.groundedBounds(100));
        assertNotNull(stock);
        assertFalse(stock.reached(Vec3d.ofBottomCenter(first)), "the initial tread need not overlap the box");
        assertTrue(course.offerResource(BlockPos.ofFloored(feet), first, Direction.SOUTH, 0, stock, foot -> true));
        assertTrue(course.offerResource(first, second, Direction.SOUTH, 1, stock, foot -> true));
        assertFalse(course.offerResource(second, second.west(), Direction.WEST, 0, stock, foot -> {
            fail("do not try a tread pointing away from the grounded site");
            return true;
        }));
        assertFalse(course.offerResource(second, stance, Direction.EAST, 0, stock, foot -> false),
            "the grounded item cannot authorize a clipped endpoint");
        assertTrue(course.offerResource(second, stance, Direction.EAST, 0, stock, foot -> true));
        assertTrue(stock.reached(Vec3d.ofBottomCenter(stance)));
        assertFalse(pickup.stockGained(0), "neither arrival nor overlap is wood in inventory");
        assertTrue(pickup.stockGained(1));
        assertNull(pickup.groundedBounds(127), "do not start another leg from a stale drop location");
    }

    @Test
    void aThreatOrInterruptedCrossingDoesNotOwnTimberTravelInput() {
        assertFalse(AgentOverlandSearch.resourceInputAllowed(false, true, false, false));
        assertFalse(AgentOverlandSearch.resourceInputAllowed(false, false, true, true),
            "combat or a hazard wins even after taking off");
        assertFalse(AgentOverlandSearch.resourceInputAllowed(true, true, true, false),
            "a safety turn cannot hand back stale crossing authority");
        assertFalse(AgentOverlandSearch.resourceInputAllowed(true, false, false, false),
            "air contact cannot nominate another tread");
        assertTrue(AgentOverlandSearch.resourceInputAllowed(true, true, false, false));
        assertTrue(AgentOverlandSearch.resourceInputAllowed(true, false, true, true));
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
