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
    void timberScoutTakesAWitnessedDuneShoulderInsteadOfTheConnectedCaveDescent() {
        long start = cell(0, 65, 0), mouth = cell(1, 64, 0), floor = cell(2, 63, 0);
        long shoulder = cell(0, 66, -1), crest = cell(0, 67, -2);
        chain(start, mouth, floor, cell(3, 62, 0));
        chain(start, shoulder, crest);
        route.contact(cell(1, 69, -1), 1); // A remembered high ledge without a route.

        route.exploreTimber(1, 0);
        route.plan(start, 2);
        assertEquals(shoulder, route.hop(0));
        assertEquals(crest, route.endpoint());

        route.destination(2.5, 0.5, 0.35, 63, 63);
        route.plan(start, 3);
        assertEquals(mouth, route.hop(0), "actual salvage can justify the very same descent");
        assertEquals(floor, route.endpoint());
        assertTrue(route.exact());
    }

    @Test
    void aRenderedGreenHorizonBiasesOnlyTheConnectedSearch() {
        long start = cell(0, 65, 0), dune = cell(1, 66, 0);
        long bank = cell(0, 65, -1), further = cell(0, 64, -2);
        long green = cell(0, 64, -12);
        chain(start, dune);
        chain(start, bank, further);
        route.contact(green, 1);
        route.exploreTimber(1, 0);

        route.witnessTimberHorizon(start, green, 2);
        route.plan(start, 2);

        assertEquals(bank, route.hop(0));
        assertFalse(route.exact(), "habitat steers exploration but is not a wood destination");
        assertFalse(route.hasPath(start, green, 2), "a rendered horizon cannot join the route graph");
    }

    @Test
    void timberKeepsItsCourseAndPaidFrontiersAfterATargetedDetour() {
        long start = cell(0, 65, 0), side = cell(0, 65, 1);
        long ahead = cell(1, 65, 0), behind = cell(-1, 65, 0);
        chain(start, side);
        route.exploreTimber(1, 0);
        route.plan(start, 1);
        route.consumeLook(start);
        route.landed(start, side, 2);
        route.consumeLook(side);
        route.destination(0.5, 0.5, 0.35, 65, 65);
        route.plan(side, 3);
        route.landed(side, start, 4);
        chain(start, ahead);
        chain(start, behind);

        route.exploreTimber(-1, 0); // The last walk/camera direction is not a new search course.
        route.plan(start, 5);
        assertEquals(ahead, route.hop(0));
        assertFalse(route.canLook(side), "a supply detour did not unspend the way out");

        route.retire(start, ahead, Integer.MAX_VALUE);
        route.plan(start, 6);
        assertEquals(behind, route.hop(0), "a real alternate is still legal against the course");
    }

    @Test
    void timberAvoidsTheWalkedDryAreaWhenAnotherSectorHasAConnectedApproach() {
        long start = cell(0, 65, 0), dry = cell(1, 65, 0), fresh = cell(-1, 65, 0);
        route.exploreTimber(1, 0);
        long foot = cell(7, 65, 1);
        for (int x = 6; x >= 0; x--) {
            long next = cell(x, 65, 1);
            chain(foot, next);
            route.plan(foot, 1);
            route.landed(foot, next, 1);
            foot = next;
        }
        chain(foot, start);
        route.landed(foot, start, 2);
        chain(start, dry);
        chain(start, fresh);

        route.plan(start, 3);
        assertEquals(fresh, route.hop(0), "new ground outranks a few unvisited squares in the same dry bend");

        route.retire(start, fresh, Integer.MAX_VALUE);
        route.plan(start, 4);
        assertEquals(dry, route.hop(0), "coarse private coverage is a preference, not a movement veto");
    }

    @Test
    void timberCanRecoverToAnUnspentHighViewInsteadOfGoingDeeperAfterSupplyWork() {
        long low = cell(0, 64, 0), shoulder = cell(-1, 65, 0), crest = cell(-2, 66, 0);
        long mouth = cell(1, 63, 0), pit = cell(2, 62, 0);
        chain(low, shoulder, crest);
        route.exploreTimber(1, 0);
        route.plan(low, 1);
        route.landed(low, shoulder, 2);
        route.landed(shoulder, crest, 3);

        route.destination(0.5, 0.5, 0.35, 64, 64);
        route.plan(crest, 3);
        route.landed(crest, shoulder, 4);
        route.landed(shoulder, low, 5);
        chain(low, mouth, pit);

        route.exploreTimber(1, 0);
        route.plan(low, 6);
        assertEquals(shoulder, route.hop(0));
        assertEquals(crest, route.endpoint(), "a connected, still-unexamined crest is worth the recovery");

        route.retire(shoulder, crest, Integer.MAX_VALUE);
        route.plan(low, 7);
        assertEquals(mouth, route.hop(0), "a refused climb does not block the remaining normal detour");
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
    void aSettledSandOutletReopensOnlyItsPaidViewAfterOneCheckedCut() {
        long sand = cell(0, 64, 0), previous = cell(1, 64, 0), opened = cell(0, 64, 1);
        route.exploreFood(0, 1);
        chain(sand, previous);
        route.landed(sand, previous, 1);
        route.plan(previous, 1);
        route.consumeLook(previous);
        route.plan(sand, 2);
        assertFalse(route.beginFoodOutlet(sand), "the ordinary frontier has not been paid");

        route.consumeLook(sand);
        route.plan(sand, 3);
        assertTrue(route.beginFoodOutlet(sand));
        assertFalse(route.beginFoodOutlet(sand), "the side survey is bounded at this stance");
        assertFalse(route.foodOutletOpened(sand), "a survey or stationary turn is not a cut");
        assertTrue(route.armFoodOutletCut(sand));
        assertFalse(route.foodOutletOpened(previous), "only the exact edited stance can replan");
        assertTrue(route.foodOutletOpened(sand));
        assertFalse(route.foodOutletOpened(sand), "one cut buys one fresh look");
        assertTrue(route.canLook(sand));
        assertFalse(route.canLook(previous));
        assertFalse(route.atForagingFoot(sand), "open sand is not a food habitat");
        assertFalse(route.hasPath(sand, opened, 4), "a cut is not an observed edge or a landing");

        route.consumeLook(sand);
        route.plan(sand, 5);
        assertFalse(route.armFoodOutletCut(sand), "a paid replan cannot start another cut");
    }

    @Test
    void aSandOutletPrefersAConnectedUnexaminedViewToCutting() {
        long sand = cell(0, 64, 0), lower = cell(-1, 63, 0);
        chain(sand, lower);
        route.exploreFood(1, 0);
        route.plan(lower, 1);
        route.landed(lower, sand, 2);
        route.consumeLook(sand);
        route.plan(sand, 3);
        assertEquals(NO_CELL, route.hop(0), "ordinary scouting did not revisit the adjacent lower viewpoint");

        assertTrue(route.beginFoodOutlet(sand));
        route.plan(sand, 4);
        assertEquals(lower, route.hop(0), "the settled outlet check prefers a real, untouched alternate view");
        assertFalse(route.armFoodOutletCut(sand));
    }

    @Test
    void failedFoodEgressPaysForOneBacktrackInsteadOfDescendingToReplayBothRises() {
        long start = cell(0, 50, 0), lower = cell(1, 49, 0), dryBranch = cell(2, 48, 0);
        long shoulder = cell(0, 51, -1), apex = cell(0, 52, -2);
        chain(start, lower, dryBranch);
        chain(start, shoulder, apex);
        route.landed(start, lower, 1);
        route.landed(lower, dryBranch, 1);
        route.exploreFood(1, 0);
        route.plan(start, 1);
        route.foodEgressLanded(start, shoulder, 1);
        route.consumeLook(shoulder);
        assertTrue(route.foodEgressLanded(shoulder, apex, 1));
        route.consumeLook(apex);

        route.plan(apex, 2);
        assertEquals(shoulder, route.hop(0), "back up to the last landed shoulder, even against the search heading");
        route.landed(apex, shoulder, 3);
        route.consumeLook(shoulder);
        route.plan(shoulder, 3);
        assertEquals(NO_CELL, route.hop(0), "an unchanged dry branch cannot carry the scout down to the old start");
        assertFalse(route.foodEgressLanded(shoulder, apex, 4), "replaying the same rise does not buy another excursion");
        route.plan(apex, 4);
        assertEquals(NO_CELL, route.hop(0));
    }

    @Test
    void failedFoodEgressCanStillFollowANewWitnessedExitOrFreshForagingGround() {
        long shoulder = cell(0, 51, -1), apex = cell(0, 52, -2);
        long stair = cell(-1, 50, -1), flank = cell(-2, 51, -1), exit = cell(-3, 52, -1);
        chain(shoulder, apex);
        route.exploreFood(1, 0);
        route.foodEgressLanded(shoulder, apex, 1);
        route.consumeLook(apex);
        route.plan(apex, 2);
        route.landed(apex, shoulder, 3);
        route.consumeLook(shoulder);

        chain(shoulder, stair, flank);
        route.observe(flank, exit, 4);
        route.plan(shoulder, 4);
        assertEquals(NO_CELL, route.hop(0), "an unwalked lower connector does not pay for the detour");
        route.landed(shoulder, stair, 5);
        route.plan(shoulder, 5);
        assertEquals(stair, route.hop(0), "a walked lower connector may lead to a distinct route back up");
        assertEquals(exit, route.endpoint());

        route.retire(flank, exit, Integer.MAX_VALUE);
        route.witnessForagingTop(stair, 6);
        route.plan(shoulder, 6);
        assertEquals(stair, route.hop(0), "a fresh foraging destination also justifies a descent");
    }

    @Test
    void flatAndUnlandedFoodEgressDoNotCreateAHighWaterMark() {
        long start = cell(0, 50, 0), flat = cell(1, 50, 0), lower = cell(2, 49, 0);
        chain(start, flat, lower);
        route.observe(flat, cell(1, 51, -1), 1);
        route.exploreFood(1, 0);
        assertFalse(route.foodEgressLanded(start, flat, 1));
        route.observe(flat, lower, 102); // Only the attempted rise has gone out of sight.
        route.plan(flat, 102);
        assertEquals(lower, route.hop(0), "an aimed rise without landing does not restrict the ordinary band");
    }

    @Test
    void aSpentFoodEgressDoesNotRetryForConsumedStockButCanRetryWithANewPickOrLight() {
        var spent = new AgentProgress.FoodEgressStock(35, 35, 0, 0);
        assertFalse(new AgentProgress.FoodEgressStock(0, 0, 0, 0).improves(spent));
        assertFalse(new AgentProgress.FoodEgressStock(35, 35, 0, 0).improves(spent));
        assertTrue(new AgentProgress.FoodEgressStock(131, 131, 0, 0).improves(spent));
        assertTrue(new AgentProgress.FoodEgressStock(35, 35, 0, 1).improves(spent));
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
