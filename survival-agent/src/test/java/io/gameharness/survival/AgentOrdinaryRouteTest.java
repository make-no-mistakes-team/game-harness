package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.cell;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class AgentOrdinaryRouteTest {
    private final AgentOrdinaryRoute route = new AgentOrdinaryRoute();

    @Test
    void exhaustedScoutCanReturnToADistinctUnexaminedJunctionWithoutRepeatingItsLook() {
        long start = cell(0, 64, 0), mid = cell(1, 64, 0), tip = cell(2, 64, 0);
        chain(start, mid, tip);
        route.contact(cell(6, 63, 0), 1); // Another remembered place, but no connecting path.
        route.explore(1, 0);
        route.plan(start, 1);
        route.landed(start, mid, 2);
        route.landed(mid, tip, 3);
        route.plan(tip, 3);
        assertEquals(NO_CELL, route.hop(0), "first inspect the present view");
        route.consumeLook(tip);
        route.plan(tip, 4);
        assertEquals(start, route.endpoint());
        assertEquals(mid, route.hop(0));
        route.landed(tip, mid, 5);
        route.landed(mid, start, 6);
        route.consumeLook(start);
        route.plan(start, 7);
        assertEquals(NO_CELL, route.hop(0), "do not bounce back to the same spent perspective");
    }

    @Test
    void optionalFoodVantageNeedsAWitnessedRouteAndCannotReplaceTheCurrentIntent() {
        long start = cell(0, 70, 0), ahead = cell(1, 70, 0), field = cell(2, 69, 0);
        chain(start, ahead);
        route.contact(field, 1);
        route.explore(1, 0);
        route.plan(start, 2);
        assertFalse(route.hasPath(start, field, 2));
        assertEquals(ahead, route.hop(0));
        route.observe(ahead, field, 3);
        assertTrue(route.hasPath(start, field, 3));
        assertEquals(ahead, route.hop(0));
        route.retire(ahead, field, 20);
        assertFalse(route.hasPath(start, field, 3));
    }

    @Test
    void recheckingAReturnEdgeDoesNotConsumeTheWalkHome() {
        long home = cell(0, 64, 0), ledge = cell(1, 65, 0);
        chain(home, ledge);
        route.destination(0.5, 0.5, 0.4, 64, 64);
        route.plan(ledge, 10);
        route.rememberReturn(ledge, home, 10);
        assertEquals(home, route.hop(0));
        route.landed(ledge, home, 19);
        assertEquals(0, route.remaining());
    }

    @Test
    void aFoodScoutDoesNotTurnBackAlongItsLastEdgeForAnEquallyWorkableFrontier() {
        long start = cell(0, 71, 0), perch = cell(1, 72, 0);
        long ahead = cell(2, 72, 0), alternate = cell(-1, 71, 0);
        chain(start, perch);
        route.explore(-1, 0); // The only witnessed way out initially goes against our heading.
        route.plan(start, 1);
        route.landed(start, perch, 2);

        chain(perch, ahead);
        chain(start, alternate);
        route.plan(perch, 3);
        assertEquals(ahead, route.hop(0), "a search without a known target can keep its new heading");

        route.retire(perch, ahead, 100);
        route.plan(perch, 4);
        assertEquals(start, route.hop(0), "turn back when it is the only real route to a new vantage");
        assertEquals(alternate, route.endpoint());
    }

    @Test
    void foodScoutChoosesWoodlandOverAnAlreadyConnectedRockStair() {
        long surface = cell(0, 66, 0), grass = cell(0, 66, 1);
        long mouth = cell(1, 65, 0), lip = cell(2, 64, 0), shaft = cell(3, 63, 0);
        chain(surface, mouth, lip, shaft, cell(4, 62, 0));
        chain(surface, grass);
        route.rememberForagingFoot(surface, 1);
        route.exploreFood(1, 0);

        route.plan(surface, 2);
        assertEquals(grass, route.hop(0), "bare descents are a poorer food prospect than the woodland");

        route.plan(lip, 3);
        for (int offset = 0; offset < route.remaining(); offset++)
            assertTrue(AgentRouteGraph.y(route.hop(offset)) >= 64, "a connected shaft is not an untargeted food route");
        assertTrue(route.hasPath(lip, shaft, 3), "food search must not destroy the underlying dry lane");

        route.destination(3.5, 0.5, 0.35, 63, 63);
        route.plan(lip, 4);
        assertEquals(shaft, route.hop(0), "an exact edible sighting is not subject to the terrain prior");
    }

    @Test
    void foodScoutReturnsToWitnessedGroundWithoutReopeningSpentViews() {
        long surface = cell(0, 66, 0), slope = cell(1, 65, 0);
        long lip = cell(2, 64, 0), shaft = cell(3, 63, 0), depth = cell(4, 62, 0);
        chain(surface, slope, lip, shaft, depth);
        route.rememberForagingFoot(surface, 1);
        route.exploreFood(1, 0);
        route.plan(surface, 1);
        route.consumeLook(surface);

        route.plan(depth, 2);
        assertEquals(surface, route.endpoint());
        assertEquals(shaft, route.hop(0));
        route.landed(depth, shaft, 3);
        route.landed(shaft, lip, 4);
        route.plan(lip, 4);
        assertEquals(surface, route.endpoint(), "crossing the elevation bound does not give up the return");
        route.landed(lip, slope, 5);
        route.landed(slope, surface, 6);
        route.plan(surface, 6);

        assertFalse(route.canLook(surface));
        assertEquals(NO_CELL, route.hop(0), "do not restart the same spent shaft excursion");
    }

    @Test
    void aFreshLowerForagingTopCanBridgeTheScoutBandButAPastSightCannot() {
        long surface = cell(0, 66, 0), shoulder = cell(1, 65, 0), rock = cell(2, 64, 0);
        long grass = cell(3, 63, 0), shaft = cell(4, 62, 0);
        chain(surface, shoulder, rock, grass, shaft);
        route.rememberForagingFoot(surface, 1);
        route.witnessForagingTop(grass, 1);
        route.exploreFood(1, 0);

        route.plan(rock, 2);
        assertEquals(grass, route.hop(0));
        assertEquals(grass, route.endpoint(), "the witnessed grass does not license the rock stair beyond it");

        route.plan(rock, 102);
        assertNotEquals(grass, route.hop(0), "expired habitat evidence cannot carry a queued descent");
    }

    @Test
    void aColdStartOnRockDoesNotInventAForagingDestinationOrFollowAnUnboundedDescent() {
        long restored = cell(0, 50, 0), step = cell(1, 49, 0), lip = cell(2, 48, 0);
        chain(restored, step, lip, cell(3, 47, 0), cell(4, 46, 0));
        route.exploreFood(1, 0);
        route.plan(restored, 1);
        route.consumeLook(restored);
        route.landed(restored, step, 2);
        route.plan(step, 2);
        route.landed(step, lip, 3);
        route.consumeLook(lip);
        route.plan(lip, 3);

        assertFalse(route.returningForFood(), "a restored dry foot is not a remembered outdoor destination");
        assertEquals(NO_CELL, route.hop(0), "the local scout is spent and may yield to safe supply egress");
    }

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
