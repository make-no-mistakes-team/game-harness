package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.cell;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class AgentOrdinaryRouteTest {
    private final AgentOrdinaryRoute route = new AgentOrdinaryRoute();

    @Test
    void routesAroundAnOpenUThroughWitnessedSidewaysAndAwayTreads() {
        long start = cell(0, 64, 0), goal = cell(2, 64, 0);
        long[] dogleg = {
            cell(0, 64, -1), cell(0, 64, -2), cell(1, 64, -2), cell(2, 64, -2), cell(2, 64, -1), goal
        };
        chain(start, dogleg);
        route.destination(2.5, 0.5, 0.35, 64, 64);

        route.plan(start, 1);

        assertTrue(route.exact());
        assertEquals(goal, route.endpoint());
        assertEquals(dogleg.length, route.remaining());
        for (int i = 0; i < dogleg.length; i++) assertEquals(dogleg[i], route.hop(i));
    }

    @Test
    void retainsTheSelectedGradeSuffixThroughMoreViewsAndConsumesOnlyActualLandings() {
        long start = cell(0, 64, 0), jump = cell(1, 65, 0), descend = cell(2, 64, 0);
        chain(start, jump, descend);
        route.destination(2.5, 0.5, 0.35, 64, 64);
        route.plan(start, 1);
        int plan = route.plans();

        chain(start, cell(0, 64, 1), cell(1, 64, 1), cell(2, 64, 1), descend);
        route.plan(start, 2);
        assertEquals(plan, route.plans());
        assertEquals(jump, route.hop(0));

        route.landed(start, jump, 3);
        route.plan(jump, 3);
        assertEquals(plan, route.plans());
        assertEquals(descend, route.hop(0));
        assertEquals(1, route.remaining());
    }

    @Test
    void invalidatingOneEdgeReplansLocallyToTheSameDestination() {
        long start = cell(0, 64, 0), straight = cell(1, 64, 0), goal = cell(2, 64, 0);
        long side = cell(0, 64, 1);
        chain(start, straight, goal);
        chain(start, side, cell(1, 64, 1), cell(2, 64, 1), goal);
        route.destination(2.5, 0.5, 0.35, 64, 64);
        route.plan(start, 1);
        assertEquals(straight, route.hop(0));

        route.retire(start, straight, 30);
        route.plan(start, 2);

        assertEquals(side, route.hop(0));
        assertEquals(goal, route.endpoint());
        assertTrue(route.exact());
        assertEquals(2, route.plans());
    }

    @Test
    void proxyDoesNotChangeDestinationAndUnknownSpaceDoesNotBecomeAFloor() {
        long start = cell(0, 64, 0), proxy = cell(1, 64, 0), goal = cell(3, 64, 0);
        chain(start, proxy);
        route.contact(goal, 1); // A disconnected remembered stance is not a traversable shortcut.
        route.destination(3.5, 0.5, 0.35, 64, 64);
        route.plan(start, 1);
        assertEquals(proxy, route.endpoint());
        assertFalse(route.exact());
        route.landed(start, proxy, 2);
        route.plan(proxy, 2);
        assertEquals(NO_CELL, route.hop(0));

        chain(proxy, cell(2, 64, 0), goal);
        route.plan(proxy, 3);
        assertTrue(route.exact());
        assertEquals(goal, route.endpoint());
    }

    @Test
    void spentViewsAndAnUnchangedGraphCannotRestartSearchOrRequestMoreLooking() {
        long start = cell(0, 64, 0);
        route.contact(start, 1);
        route.explore(0, 1);
        route.plan(start, 1);
        route.consumeLook(start);
        for (int tick = 2; tick < 20; tick++) {
            route.contact(start, tick);
            route.plan(start, tick);
            assertEquals(NO_CELL, route.endpoint());
            assertFalse(route.canLook(start));
        }
        assertEquals(0, route.plans());
    }

    private void chain(long start, long... feet) {
        route.contact(start, 1);
        for (long foot : feet) {
            route.observe(start, foot, 1);
            route.observe(foot, start, 1);
            start = foot;
        }
    }
}
