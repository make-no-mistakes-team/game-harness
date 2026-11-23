package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.cell;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

final class AgentOrdinaryNavigatorTest {
    @Test
    void anActuallySpentBootstrapCanYieldWithoutStealingAnotherEdgeOrAnotherGoal() {
        var spent = new AgentProgress.SpentSurfaceRoute();
        var foot = new BlockPos(4, 75, 8);
        var job = AgentOrdinaryNavigator.Job.STONE;
        spent.observe(job, foot, 3, true, false);
        assertFalse(spent.yields(job, foot, 65, true), "one old refusal cannot release a route");
        for (int tick = 100; tick <= 160; tick += 5) spent.observe(job, foot, tick, true, false);
        assertTrue(spent.yields(job, foot, 161, false), "a permanently exhausted first-stone search must let recovery act");
        assertFalse(spent.yields(AgentOrdinaryNavigator.Job.FOOD, foot, 161, false));
        assertFalse(spent.yields(job, foot.east(), 161, true), "a different stance gets its own normal route");
        spent.observe(job, foot, 162, false, true);
        assertFalse(spent.yields(job, foot, 163, true), "a genuinely available route takes back the work");
    }

    @Test
    void aPaidFrontierViewSurvivesLaterResourceScansWithoutInventingARoute() {
        var view = new AgentOrdinaryNavigator.FrontierView();
        var route = new AgentOrdinaryRoute();
        long here = cell(0, 0, 0);
        route.explore(0, 1);
        route.contact(here, 1);
        view.begin(7);

        assertEquals(AgentOrdinaryNavigator.Sight.STALE_FRAME, view.admit(7, true, true, 48));
        assertEquals(AgentOrdinaryNavigator.Sight.STALE_FRAME, view.admit(8, false, true, 48));
        assertEquals(AgentOrdinaryNavigator.Sight.BAD_FACING, view.admit(8, true, false, 48));
        assertEquals(AgentOrdinaryNavigator.Sight.RAY_BUDGET, view.admit(8, true, true, 12));
        assertFalse(view.complete(route, here, 2));
        assertTrue(route.canLook(here));
        assertFalse(AgentOrdinaryNavigator.frontierSpent(route, here, null),
            "a deferred render has not spent the first-log frontier");

        assertEquals(AgentOrdinaryNavigator.Sight.READY, view.admit(9, true, true, 48));
        view.pay(9, AgentOrdinaryNavigator.Sight.NO_NEIGHBOR, true);
        assertEquals(AgentOrdinaryNavigator.Sight.NO_NEIGHBOR, view.admit(9, true, true, 0));
        assertTrue(view.complete(route, here, 3));
        assertFalse(route.canLook(here));
        assertEquals(NO_CELL, route.hop(0));
        assertFalse(route.exact());
        assertTrue(AgentOrdinaryNavigator.frontierSpent(route, here, null));
        assertFalse(AgentOrdinaryNavigator.frontierSpent(route, cell(4, 0, 0), null),
            "an unpaid second footing cannot borrow the first one's frontier");
        assertFalse(AgentOrdinaryNavigator.frontierSpent(route, here, new Vec3d(2, 0, 0)),
            "a blocked approach to a known trunk is not an exhausted frontier");
        assertEquals(AgentOrdinaryNavigator.Sight.RAY_BUDGET, view.admit(10, true, true, 0),
            "another frame cannot borrow a stale empty snapshot");
    }

    @Test
    void anAimedViewWithNoProjectedSupportCanUseAConnectedGroundedJunction() {
        var view = new AgentOrdinaryNavigator.FrontierView();
        var route = new AgentOrdinaryRoute();
        long junction = cell(0, 0, 0), tread = cell(1, 0, 0), tip = cell(2, 0, 0);
        route.explore(1, 0);
        route.landed(junction, tread, 1);
        route.rememberReturn(tread, junction, 1);
        route.landed(tread, tip, 2);
        route.rememberReturn(tip, tread, 2);
        route.plan(junction, 2);
        route.plan(tread, 3);
        route.plan(tip, 4);
        assertEquals(NO_CELL, route.hop(0));

        view.begin(11);
        view.pay(12, AgentOrdinaryNavigator.Sight.NO_PROJECTED_SUPPORT, true);
        assertTrue(view.complete(route, tip, 5));
        assertEquals(tread, route.hop(0));
        assertEquals(junction, route.endpoint());
        assertFalse(route.exact(), "a new viewpoint is not a destination arrival");
        assertFalse(AgentOrdinaryNavigator.frontierSpent(route, tip, null),
            "a connected walking alternative still belongs to the ordinary navigator");
    }

    @Test
    void aMotorBoundDoesNotEraseTheJustWalkedReturnOrOverrideALiveVeto() {
        var route = new AgentOrdinaryRoute();
        long before = cell(0, 0, 0), here = cell(1, 0, 0), unwalked = cell(2, 0, 0);
        route.landed(before, here, 1);
        route.rememberReturn(here, before, 1);
        route.observe(here, unwalked, 1);
        route.destination(0.5, 0.5, 0.3, 0, 0);
        route.plan(here, 2);
        assertEquals(before, route.hop(0));
        assertFalse(route.deferWalked(here, unwalked, 24));
        assertTrue(route.deferWalked(here, before, 24));
        route.retire(here, unwalked, Integer.MAX_VALUE);

        route.plan(here, 3);
        assertEquals(NO_CELL, route.hop(0));
        route.plan(here, 23);
        assertEquals(NO_CELL, route.hop(0), "the same failed motion does not restart immediately");
        route.plan(here, 24);
        assertEquals(before, route.hop(0), "the real prior contact survives without another first-hit ray");
        route.retire(here, before, Integer.MAX_VALUE);
        assertFalse(route.deferWalked(here, before, 48));
        route.plan(here, 100);
        assertEquals(NO_CELL, route.hop(0), "a real obstruction is not reopened by the motor timeout policy");
    }

    @Test
    void aNeutralRenderTurnKeepsTheSameInProgressEdgeAndDoesNotResetItsBounds() {
        var travel = new AgentOrdinaryNavigator.EdgeTravel();
        travel.begin(1, 1);
        travel.startMotion(new Vec3d(0.0, 1.0, 0.0));
        assertTrue(travel.keepTurn(2));
        assertTrue(travel.observe(new Vec3d(0.30, 1.0, 0.0)));
        assertFalse(travel.expired(2, 0.30));
        // No rendered input: the owner sees physical coasting, not an interposed motor.
        assertTrue(travel.keepTurn(3));
        assertTrue(travel.observe(new Vec3d(0.49, 1.0, 0.0)));
        assertFalse(travel.expired(3, 0.49));
        assertTrue(travel.keepTurn(4));
        assertTrue(travel.observe(new Vec3d(0.60, 0.92, 0.0)));
        assertTrue(travel.traversed());
        assertFalse(travel.expired(4, 0.60));
        for (int tick = 5; tick < 20; tick++) {
            assertTrue(travel.keepTurn(tick));
            assertFalse(travel.expired(tick, 0.60));
        }
        assertTrue(travel.keepTurn(20));
        assertTrue(travel.expired(20, 0.60), "renewing ownership did not renew the progress clock");
        assertFalse(travel.keepTurn(22), "an unowned body tick cannot certify this path");
    }

    @Test
    void oneTreadScoutReturnsKeepTheirGazeThroughOutBackSideAndBack() {
        var route = new AgentOrdinaryRoute();
        var travel = new AgentOrdinaryNavigator.EdgeTravel();
        var hub = new BlockPos(-61, 72, 22);
        var south = hub.south();
        var east = hub.east();
        route.observe(hub.asLong(), south.asLong(), 590);
        route.observe(hub.asLong(), east.asLong(), 590);
        route.explore(0, 1);
        route.plan(hub.asLong(), 591);
        assertEquals(south.asLong(), route.hop(0));
        land(route, travel, hub, south, 598);

        route.plan(south.asLong(), 600);
        assertEquals(hub.asLong(), route.hop(0));
        assertEquals(east.asLong(), route.hop(1));
        float southGaze = travel.flatRetraceYaw(south, hub, route.hop(1), Direction.NORTH, 0, 600);
        assertEquals(0f, southGaze, "do not request north just to walk one tread back");
        assertEquals(AgentBody.FlatKey.BACK, AgentBody.ordinaryFlatKey(southGaze, Direction.NORTH));
        assertEquals(-90f, travel.flatRetraceYaw(south, hub, route.hop(1), Direction.NORTH, -88, 600),
            "a view already facing the outgoing route needs only a small correction");
        assertEquals(AgentBody.FlatKey.LEFT, AgentBody.ordinaryFlatKey(-88, Direction.NORTH));
        land(route, travel, south, hub, 609);

        route.plan(hub.asLong(), 610);
        assertEquals(east.asLong(), route.hop(0));
        assertTrue(Float.isNaN(travel.flatRetraceYaw(hub, east, route.hop(1), Direction.EAST, 0, 610)),
            "the actual outgoing edge turns normally");
        land(route, travel, hub, east, 628);

        route.explore(-1, 0);
        route.plan(east.asLong(), 630);
        assertEquals(hub.asLong(), route.hop(0));
        float eastGaze = travel.flatRetraceYaw(east, hub, route.hop(1), Direction.WEST, -90, 630);
        assertEquals(-90f, eastGaze, "the next exploration segment also keeps the useful view");
        assertEquals(AgentBody.FlatKey.BACK, AgentBody.ordinaryFlatKey(eastGaze, Direction.WEST));
        assertEquals(270f, travel.flatRetraceYaw(east, hub, route.hop(1), Direction.WEST, 270, 630));
        assertEquals(AgentBody.FlatKey.RIGHT, AgentBody.ordinaryFlatKey(0, Direction.WEST));
        assertEquals(AgentBody.FlatKey.LEFT, AgentBody.ordinaryFlatKey(0, Direction.EAST));
        assertEquals(AgentBody.FlatKey.FORWARD, AgentBody.ordinaryFlatKey(0, Direction.SOUTH));
        route.retire(east.asLong(), hub.asLong(), 655);
        route.plan(east.asLong(), 631);
        assertEquals(AgentRouteGraph.NO_CELL, route.hop(0), "a live veto withdraws the remembered return from the plan");
        var still = Vec3d.ofBottomCenter(east);
        travel.startMotion(still);
        assertTrue(travel.observe(still));
        assertFalse(travel.traversed(), "planning, key choice, and gaze did not move the body");
    }

    @Test
    void onlyTheLatestExactFlatReturnWithNoLongerStraightSuffixCanKeepItsGaze() {
        var travel = new AgentOrdinaryNavigator.EdgeTravel();
        var hub = new BlockPos(-61, 72, 22);
        var tip = hub.south();
        long end = AgentRouteGraph.NO_CELL;
        assertTrue(Float.isNaN(travel.flatRetraceYaw(tip, hub, end, Direction.NORTH, 0, 91)));
        travel.noteLanding(hub, tip, 90);
        assertTrue(Float.isNaN(travel.flatRetraceYaw(tip, hub, hub.north().down().asLong(), Direction.NORTH, 0, 91)));
        assertTrue(Float.isNaN(travel.flatRetraceYaw(tip, hub, end, Direction.NORTH, 41, 91)));
        assertTrue(Float.isNaN(travel.flatRetraceYaw(tip, hub, end, Direction.NORTH, 0, 128)));
        travel.noteLanding(hub.east(), hub, 92);
        assertTrue(Float.isNaN(travel.flatRetraceYaw(tip, hub, end, Direction.NORTH, 0, 93)));
        travel.noteLanding(hub, tip.up(), 94);
        assertTrue(Float.isNaN(travel.flatRetraceYaw(tip.up(), hub, end, Direction.NORTH, 0, 95)));
    }

    private static void land(AgentOrdinaryRoute route, AgentOrdinaryNavigator.EdgeTravel travel,
                             BlockPos from, BlockPos to, int tick) {
        var start = Vec3d.ofBottomCenter(from);
        var finish = Vec3d.ofBottomCenter(to);
        travel.begin(tick - 3, tick - 3);
        travel.startMotion(start);
        for (int step = 1; step <= 3; step++) {
            assertTrue(travel.keepTurn(tick - 3 + step));
            assertTrue(travel.observe(start.lerp(finish, step / 3.0)));
        }
        assertTrue(travel.traversed());
        route.landed(from.asLong(), to.asLong(), tick);
        route.rememberReturn(to.asLong(), from.asLong(), tick);
        travel.noteLanding(from, to, tick);
    }

    @Test
    void recallLooksOnlyTowardThePredecessorOfTheActualStance() {
        var grounded = new BlockPos(-61, 72, 22);
        var predecessor = grounded.west().up();
        var untraversedSuffix = grounded.east();
        assertEquals(predecessor, AgentOrdinaryNavigator.recalledPredecessor(
            List.of(predecessor.west(), predecessor, grounded, untraversedSuffix), grounded));
        assertNull(AgentOrdinaryNavigator.recalledPredecessor(List.of(predecessor, untraversedSuffix), grounded));
    }

    @Test
    void recallDoesNotBridgeAGapADiagonalOrANonOrdinaryDrop() {
        var grounded = new BlockPos(-61, 72, 22);
        for (var invalid : List.of(grounded.west(2), grounded.north().east(), grounded.east().up(2), grounded.up())) {
            assertNull(AgentOrdinaryNavigator.recalledPredecessor(List.of(grounded.west(), invalid, grounded), grounded));
        }
        assertNull(AgentOrdinaryNavigator.recalledPredecessor(
            List.of(grounded.west(), grounded, grounded.west(2), grounded), grounded),
            "an older occurrence cannot repair the gap in the latest observed leg");
    }
}
