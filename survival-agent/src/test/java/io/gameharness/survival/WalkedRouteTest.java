package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.cell;
import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

final class WalkedRouteTest {
    @Test
    void canRecallOutOfSightThroughPreplacementLegsAndHeightChanges() {
        var route = new AgentWalkedRoute();
        long entry = cell(-4, -13, -2), middle = cell(-3, -12, -2), furnace = cell(-3, -12, -1);
        route.landed(entry, middle);
        route.landed(middle, furnace);
        route.anchor(furnace);
        long shelf = cell(-2, -13, -1);
        route.landed(furnace, shelf);
        long end = shelf;
        for (int x = -1; x <= 12; x++) {
            long next = cell(x, -13, -1);
            route.landed(end, next);
            end = next;
        }

        assertEquals(middle, route.next(entry));
        assertEquals(furnace, route.next(middle));
        assertEquals(cell(11, -13, -1), route.next(end));
        assertEquals(furnace, route.next(shelf));
        var saved = route.breadcrumbs(end);
        assertTrue(AgentWalkedRoute.validBreadcrumbs(saved, -3, -12, 0));
        assertEquals(15, saved.edges().length);
        var child = new AgentWalkedRoute();
        child.restore(saved);
        assertEquals(cell(11, -13, -1), child.next(end));
        assertEquals(furnace, child.next(shelf));
        assertFalse(child.connected(entry)); // An unrelated branch didn't come with the saved return.
    }

    @Test
    void refusesDisconnectedDiagonalAndFallLinksUntilRealRejoin() {
        var route = new AgentWalkedRoute();
        long station = cell(0, 16, 0), landing = cell(1, 15, 0), afterGap = cell(2, 15, 0);
        route.anchor(station);
        route.landed(station, landing);
        route.landed(afterGap, cell(3, 15, 0));
        route.landed(station, cell(0, 12, 1)); // Fall.
        route.landed(landing, cell(2, 15, 1)); // Ambiguous diagonal.
        assertEquals(NO_CELL, route.next(afterGap));
        assertFalse(route.connected(cell(0, 12, 1)));
        assertFalse(route.connected(cell(2, 15, 1)));
        route.landed(afterGap, landing);
        assertEquals(landing, route.next(afterGap));
    }

    @Test
    void aProvedChangeCutsOnlyItsOwnBranchAndNewLifeForgetsTheOldRoute() {
        var route = new AgentWalkedRoute();
        long start = cell(0, 18, 0), split = cell(1, 18, 0), wet = cell(1, 17, 1), dry = cell(2, 18, 0);
        route.anchor(start);
        route.landed(start, split);
        route.landed(split, wet);
        route.landed(split, dry);
        route.rejected(split, wet);
        assertEquals(NO_CELL, route.next(wet));
        assertEquals(split, route.next(dry));
        route.landed(wet, split); // Actual fresh dry traverse may renew the old edge.
        assertEquals(split, route.next(wet));
        route.clear();
        route.anchor(start);
        assertFalse(route.connected(wet));
        assertFalse(route.connected(dry));
        route.anchor(dry); // A newly witnessed exact local station also works without an old path.
        assertTrue(route.connected(dry));
        assertEquals(NO_CELL, route.next(start));
    }

    @Test
    void evictionPreservesTheStationAndImmediateWitnessButNeverSynthesizesAGap() {
        var route = new AgentWalkedRoute();
        long station = cell(0, 30, 0), step = cell(1, 30, 0);
        route.landed(station, step);
        route.anchor(station);
        for (int x = 1; x <= AgentWalkedRoute.LIVE_EDGES * 2; x++)
            route.landed(cell(x, 30, 0), cell(x + 1, 30, 0));
        assertTrue(route.connected(station));
        assertEquals(station, route.next(step));
        assertEquals(NO_CELL, route.next(cell(100, 30, 0)));
        assertNull(route.breadcrumbs(cell(100, 30, 0)));
    }

    @Test
    void closedSaveLimitDoesNotLimitLiveRecallToTheNextRetainedLeg() {
        var route = new AgentWalkedRoute();
        route.anchor(cell(0, 30, 0));
        for (int x = 0; x < AgentWalkedRoute.SAVED_EDGES + 1; x++)
            route.landed(cell(x, 30, 0), cell(x + 1, 30, 0));
        long beyond = cell(AgentWalkedRoute.SAVED_EDGES + 1, 30, 0);
        long atLimit = cell(AgentWalkedRoute.SAVED_EDGES, 30, 0);
        assertEquals(atLimit, route.next(beyond));
        assertNull(route.breadcrumbs(beyond)); // Never save a disconnected suffix.
        assertEquals(AgentWalkedRoute.SAVED_EDGES, route.breadcrumbs(atLimit).edges().length);
    }

    @Test
    void discontinuityCannotBeMadeIntoTraversalByLaterMotion() {
        var motion = new AgentWalkedRoute.Motion();
        motion.start(0.5, 30, 0.5);
        assertTrue(motion.observe(0.65, 30, 0.5));
        assertFalse(motion.traversed());
        assertFalse(motion.observe(1.5, 30, 0.5));
        motion.observe(1.6, 30, 0.5);
        motion.observe(1.7, 30, 0.5);
        assertFalse(motion.traversed());
        motion.start(0.5, 30, 0.5);
        motion.observe(0.75, 30.4, 0.5);
        motion.observe(1, 30.75, 0.5);
        motion.observe(1.25, 31.1, 0.5);
        assertTrue(motion.observe(1.5, 31, 0.5));
        assertTrue(motion.traversed());
    }
}
